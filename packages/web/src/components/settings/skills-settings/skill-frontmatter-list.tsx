import type { SkillFrontmatterValue } from "@open-inspect/shared/types/skills";

/**
 * Preserved `SKILL.md` frontmatter as key/value rows. Values are shown as the
 * JSON they render to, so `true` and `"true"` stay distinguishable.
 */
export function SkillFrontmatterList({
  frontmatter,
}: {
  frontmatter: Record<string, SkillFrontmatterValue>;
}) {
  return (
    <dl className="mt-2 grid gap-2 text-sm">
      {Object.entries(frontmatter).map(([key, value]) => (
        <div key={key} className="grid grid-cols-[10rem_1fr] gap-3">
          <dt className="font-mono text-muted-foreground">{key}</dt>
          <dd className="break-all font-mono text-xs text-foreground">{JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
