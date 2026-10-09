// Structural checks on the sandbox namespace's admission policies
// (deploy/kubernetes/sandboxes/admission-policy.yaml). The CEL itself is
// exercised against a live API server by scripts/kubernetes-smoke.sh; these
// pin the shape that keeps it safe to apply: which operations each policy
// matches and which object each expression reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";

const source = readFileSync(
  new URL("../deploy/kubernetes/sandboxes/admission-policy.yaml", import.meta.url),
  "utf8"
);
const documents = parseAllDocuments(source).map((document) => {
  assert.deepEqual(document.errors, []);
  return document.toJS();
});

const CONTROL_PLANE = "system:serviceaccount:open-inspect:open-inspect-control-plane";
const SANDBOX_GC = "system:serviceaccount:open-inspect:open-inspect-sandbox-gc";
const NAMESPACE = "open-inspect-sandboxes";

function policy(name) {
  const found = documents.filter(
    (d) => d.kind === "ValidatingAdmissionPolicy" && d.metadata.name === name
  );
  assert.equal(found.length, 1, `exactly one policy ${name}`);
  return found[0];
}

function binding(name) {
  const found = documents.filter(
    (d) => d.kind === "ValidatingAdmissionPolicyBinding" && d.metadata.name === name
  );
  assert.equal(found.length, 1, `exactly one binding ${name}`);
  return found[0];
}

/** Every CEL string in a policy: variables, validations and their messages. */
function expressions(p) {
  return [
    ...(p.spec.variables ?? []).map((v) => v.expression),
    ...(p.spec.validations ?? []).flatMap((v) =>
      [v.expression, v.messageExpression].filter(Boolean)
    ),
  ];
}

function operations(p) {
  return p.spec.matchConstraints.resourceRules.flatMap((rule) => rule.operations);
}

test("the file holds three policies, each bound to the sandbox namespace and denying", () => {
  const names = documents
    .filter((d) => d.kind === "ValidatingAdmissionPolicy")
    .map((d) => d.metadata.name);
  assert.deepEqual(names, [
    "open-inspect-sandbox-pods",
    "open-inspect-sandbox-claims",
    "open-inspect-sandbox-auth-home-claims-delete",
  ]);
  for (const name of names) {
    assert.equal(policy(name).spec.failurePolicy, "Fail");
    const b = binding(name);
    assert.equal(b.spec.policyName, name);
    assert.deepEqual(b.spec.validationActions, ["Deny"]);
    assert.deepEqual(b.spec.matchResources.namespaceSelector.matchLabels, {
      "kubernetes.io/metadata.name": NAMESPACE,
    });
  }
});

test("pods: the auth-home owner label is allowed and tied to exactly one sf-home- claim", () => {
  const pods = policy("open-inspect-sandbox-pods");
  assert.deepEqual(operations(pods), ["CREATE", "UPDATE"]);
  const variables = Object.fromEntries(pods.spec.variables.map((v) => [v.name, v.expression]));
  assert.equal(variables.authHomeOwnerLabel, "'openinspect.dev/auth-home-owner'");
  assert.match(variables.authHomeClaims, /startsWith\('sf-home-'\)/);
  assert.ok(
    pods.spec.variables.some((v) => v.expression.includes("openinspect.dev/auth-home-owner")),
    "the pods policy variables name the label"
  );

  const validations = pods.spec.validations.map((v) => v.expression);
  const labelAllowlist = validations.find((e) => e.includes("'openinspect.dev/sandbox'"));
  assert.match(labelAllowlist, /variables\.authHomeOwnerLabel\]/);
  assert.ok(validations.includes("!variables.isSandbox || variables.authHomeClaims.size() <= 1"));
  const tie = validations.find((e) => e.includes("variables.authHomeClaims.size() == 0"));
  assert.ok(tie, "a validation ties the label to the claim");
  assert.match(tie, /!\(variables\.authHomeOwnerLabel in variables\.labels\)/);
  assert.match(tie, /c == 'sf-home-' \+ variables\.labels\[\?variables\.authHomeOwnerLabel\]/);
  // Not restricted to CREATE: a label added later is checked as well.
  assert.doesNotMatch(tie, /request\.operation/);
  // A sandbox may mount its workspace and a home, nothing else.
  assert.ok(
    validations.some(
      (e) =>
        e.includes("== 'oi-' + variables.sandboxHash") &&
        e.includes("claimName.startsWith('sf-home-')")
    )
  );
  // Unchanged: the scheduler cannot be bypassed.
  assert.ok(validations.includes("request.operation != 'CREATE' || !has(object.spec.nodeName)"));
});

test("claims: CREATE/UPDATE only, reading object, refusing both service accounts on sf-home-", () => {
  const claims = policy("open-inspect-sandbox-claims");
  assert.deepEqual(operations(claims), ["CREATE", "UPDATE"]);
  for (const expression of expressions(claims)) {
    assert.doesNotMatch(expression, /oldObject/);
  }
  const deny = claims.spec.validations.map((v) => v.expression).find((e) => e.includes("sf-home-"));
  assert.ok(deny, "a validation guards sf-home- claims");
  assert.match(deny, /^!object\.metadata\.name\.startsWith\('sf-home-'\) \|\|/);
  assert.ok(deny.includes(`'${CONTROL_PLANE}'`));
  assert.ok(deny.includes(`'${SANDBOX_GC}'`));
});

test("claims delete: DELETE only, reading only oldObject, refusing both service accounts", () => {
  const del = policy("open-inspect-sandbox-auth-home-claims-delete");
  assert.deepEqual(del.spec.matchConstraints.resourceRules, [
    {
      apiGroups: [""],
      apiVersions: ["v1"],
      operations: ["DELETE"],
      resources: ["persistentvolumeclaims"],
    },
  ]);
  assert.equal(del.spec.variables, undefined);
  const all = expressions(del);
  assert.equal(all.length, 1);
  for (const expression of all) {
    assert.match(expression, /oldObject/);
    // object is null on DELETE: reading it would error and, failing closed,
    // refuse every claim delete in the namespace.
    assert.doesNotMatch(expression, /(^|[^A-Za-z])object\./);
    assert.ok(!expression.includes("object."));
  }
  const [deny] = all;
  assert.match(deny, /^!oldObject\.metadata\.name\.startsWith\('sf-home-'\) \|\|/);
  assert.ok(deny.includes(`'${CONTROL_PLANE}'`));
  assert.ok(deny.includes(`'${SANDBOX_GC}'`));
});

test("the control plane identity the claims policies refuse is the one the pods policy trusts", () => {
  const pods = policy("open-inspect-sandbox-pods");
  const controlPlaneUser = pods.spec.variables.find((v) => v.name === "controlPlaneUser");
  assert.equal(controlPlaneUser.expression, `'${CONTROL_PLANE}'`);
});
