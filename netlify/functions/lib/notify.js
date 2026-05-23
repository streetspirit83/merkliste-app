/**
 * notify.js — ntfy.sh push sender (JSON body → UTF-8 sicher für Emoji)
 */

const PRIORITY = { red: 4, orange: 3, green: 3 };
const TAGS     = { red: ["rotating_light"], orange: ["warning"], green: ["white_check_mark"] };

export async function sendNtfy(topic, { title, message, pushColor = null }) {
  const body = {
    topic,
    title,
    message,
    priority: PRIORITY[pushColor] ?? 3,
    tags:     TAGS[pushColor]     ?? ["bell"],
  };
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn(`[ntfy] HTTP ${res.status} für "${title}"`);
  return res.ok;
}
