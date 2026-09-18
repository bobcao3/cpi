export const DISABLE_SKILL_FLAG = "disable-skill";

/** Parse a comma-separated skill-name list into a trimmed, deduped array. */
export function parseDisabledSkills(value) {
  if (typeof value !== "string") return [];
  const names = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Split loaded skills into visible and disabled; report requested names that
 * matched no loaded skill, so a typo cannot silently pass as a gate.
 */
export function filterDisabledSkills(skills, disabledNames) {
  const missing = disabledNames.filter(
    (name) => !skills.some((skill) => skill.name === name),
  );
  const visible = skills.filter((skill) => !disabledNames.includes(skill.name));
  return { visible, missing };
}