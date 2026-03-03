// csv_tools.js
import fs from "fs";

export function parseCSV(csvText) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cur);
        cur = "";
      } else if (ch === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else if (ch === "\r") {
        // ignore CR
      } else {
        cur += ch;
      }
    }
  }

  row.push(cur);
  rows.push(row);

  // trim trailing empty rows
  while (rows.length && rows[rows.length - 1].every(c => (c ?? "").trim() === "")) {
    rows.pop();
  }
  return rows;
}

export function csvToObjects(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (cols[i] ?? "").trim();
    });
    return obj;
  });
}

export function readCsvFileToObjects(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  return csvToObjects(text);
}

export function objectsToCsv(objects, headers) {
  const esc = (s) => {
    const v = String(s ?? "");
    if (/[",\n]/.test(v)) return `"${v.replaceAll('"', '""')}"`;
    return v;
  };

  const lines = [];
  lines.push(headers.map(esc).join(","));
  for (const o of objects) {
    lines.push(headers.map(h => esc(o[h] ?? "")).join(","));
  }
  return lines.join("\n");
}
