import fs from "fs";
import path from "path";

function parseCSV(csvText) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cur += '"'; // escaped quote
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
        // ignore
      } else {
        cur += ch;
      }
    }
  }

  // last cell
  row.push(cur);
  rows.push(row);

  // trim possible trailing empty row
  while (rows.length && rows[rows.length - 1].every(cell => (cell ?? "").trim() === "")) {
    rows.pop();
  }
  return rows;
}

export function convertCsvToCasesJson({ csvPath, jsonPath }) {
  const csvText = fs.readFileSync(csvPath, "utf8");
  const rows = parseCSV(csvText);

  if (rows.length < 2) {
    throw new Error("CSV must have a header row and at least one data row.");
  }

  const headers = rows[0].map(h => h.trim());
  const cases = rows.slice(1).map(cols => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cols[idx] ?? "").trim();
    });
    return obj;
  });

  fs.writeFileSync(jsonPath, JSON.stringify(cases, null, 2), "utf8");
  return cases.length;
}
