import "../styles/tokens.css";
import "../styles/theme-presets.css";
import "../App.css";
import "./file-tree.css";
import "./presentation.css";

const fixture = document.querySelector<HTMLElement>("#fixture");
if (!fixture) throw new Error("Missing fixture host");
const fixtureRoot = fixture;

const glyph = `
  <span class="tree-glyph" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M4 3h12l4 4v14H4z" /></svg>
  </span>`;
const action = `
  <button class="tree-more" aria-label="Actions" style="opacity:1">
    <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
  </button>`;

function caseElement(width: number, theme: "light" | "dark") {
  const host = document.createElement("section");
  host.dataset.case = `${width}-${theme}`;
  host.dataset.theme = theme;
  host.style.width = `${width}px`;
  host.style.height = "150px";
  host.style.setProperty("--type-chrome-size", "26px");
  host.style.setProperty("--type-label-size", "22px");
  host.style.borderLeft = "1px solid var(--border)";
  host.style.borderRight = "1px solid var(--border)";
  host.className = "sidebar";
  host.innerHTML = `
    <div class="filetree">
      <div class="filetree-scroll">
        <div class="tree-rowwrap" data-lock-probe>
          <div class="tree-row selected" data-row="root-default" style="height:40px;padding-left:28px">
            ${glyph}<span class="tree-label">Root note with a long title</span>${action}
          </div>
          <div class="tree-row is-dir" data-row="root-custom" style="height:40px;padding-left:28px">
            <span class="tree-disclosure open" aria-hidden="true">›</span>
            ${glyph}<span class="tree-label">Custom icon folder</span>${action}
          </div>
          <div class="tree-row" data-row="nested" style="height:40px;padding-left:44px">
            ${glyph}<span class="tree-label">Nested note with a long title</span>${action}
          </div>
        </div>
      </div>
    </div>`;
  fixtureRoot.append(host);
  return host;
}

const results = [];
for (const theme of ["light", "dark"] as const) {
  for (const width of [220, 176]) {
    const host = caseElement(width, theme);
    const frame = host.getBoundingClientRect();
    const lockProbe = host.querySelector<HTMLElement>("[data-lock-probe]");
    if (!lockProbe) throw new Error("Missing row lock probe");
    const lockStyle = getComputedStyle(lockProbe);
    const rowsLocked = !lockStyle.transitionProperty.split(",").map((value) => value.trim()).includes("top")
      && !lockStyle.willChange.split(",").map((value) => value.trim()).includes("top");
    const rows = [...host.querySelectorAll<HTMLElement>("[data-row]")];
    const rowResults = rows.map((row) => {
      const first = row.querySelector<HTMLElement>(".tree-disclosure, .tree-glyph");
      const more = row.querySelector<HTMLElement>(".tree-more");
      const label = row.querySelector<HTMLElement>(".tree-label");
      if (!first || !more || !label) throw new Error("Missing row fixture parts");
      const rowRect = row.getBoundingClientRect();
      return {
        kind: row.dataset.row,
        leftInset: first.getBoundingClientRect().left - frame.left,
        rightInset: frame.right - more.getBoundingClientRect().right,
        rowLeftDelta: rowRect.left - frame.left,
        rowRightDelta: frame.right - rowRect.right,
        labelContained: label.getBoundingClientRect().right <= more.getBoundingClientRect().left + 0.5,
      };
    });
    results.push({
      width,
      theme,
      rowsLocked,
      rows: rowResults,
      pass: rowsLocked && rowResults.every((row) =>
        row.leftInset >= 20
        && row.rightInset >= 10
        && Math.abs(row.rowLeftDelta) <= 1.1
        && Math.abs(row.rowRightDelta) <= 1.1
        && row.labelContained),
    });
  }
}

const result = { cases: results, contained: results.every((entry) => entry.pass) };
document.body.dataset.result = JSON.stringify(result);
document.title = result.contained ? "PASS" : "FAIL";
