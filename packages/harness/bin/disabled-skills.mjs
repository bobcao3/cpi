export function parseDisabledSkills(value) {
  if (typeof value !== "string") return [];
  const names = [];
  for (const part of value.split(",")) {
    const name = part.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function filterDisabledSkills(skills, disabledNames) {
  const missing = disabledNames.filter(
    (name) => !skills.some((skill) => skill.name === name),
  );
  const visible = skills.filter((skill) => !disabledNames.includes(skill.name));
  return { visible, missing };
}
