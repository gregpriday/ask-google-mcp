export function buildSystemPrompt(template, now = new Date()) {
  const currentDate = now.toISOString().slice(0, 10);
  return template.replace("{{CURRENT_DATE}}", `${currentDate} (UTC)`);
}
