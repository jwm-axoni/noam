import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import "../../App.css";
import "../editor.css";

const fixture = document.querySelector<HTMLElement>("#fixture");
if (!fixture) throw new Error("Missing fixture host");

fixture.style.width = "640px";
fixture.style.margin = "20px";

const view = new EditorView({
  state: EditorState.create({ doc: "inline PDF" }),
  parent: fixture,
});
const line = view.dom.querySelector<HTMLElement>(".cm-line");
if (!line) throw new Error("Missing CodeMirror line");

line.replaceChildren();
const embed = document.createElement("div");
embed.className = "cm-md-pdf";
embed.innerHTML = `
  <div class="pdf-viewer compact">
    <div class="preview-toolbar" aria-label="PDF controls">
      <button>Fit</button><button aria-label="Zoom in">+</button><button>Rotate</button>
      <form class="pdf-search"><input aria-label="Search PDF" value="quiet garden"><button>Find</button><button>1 of 4</button></form>
    </div>
    <div class="pdf-pages">
      <div class="pdf-page-shell"><div class="pdf-page"><canvas></canvas></div></div>
    </div>
  </div>`;
line.append(embed);

const canvas = embed.querySelector<HTMLCanvasElement>("canvas");
const toolbar = embed.querySelector<HTMLElement>(".preview-toolbar");
if (!canvas || !toolbar) throw new Error("Missing PDF fixture parts");

canvas.style.width = "480px";
canvas.style.height = "640px";
const before = view.contentDOM.scrollWidth;
canvas.style.width = "960px";
canvas.style.height = "1280px";

const editorWidth = view.dom.getBoundingClientRect().width;
const contentWidth = view.contentDOM.scrollWidth;
const toolbarRight = toolbar.getBoundingClientRect().right;
const editorRight = view.dom.getBoundingClientRect().right;
const pages = embed.querySelector<HTMLElement>(".pdf-pages");
if (!pages) throw new Error("Missing PDF pages");
const zoomScrollWidth = pages.scrollWidth;
const zoomClientWidth = pages.clientWidth;
canvas.style.width = "480px";
canvas.style.height = "640px";
const fitScrollWidth = pages.scrollWidth;
const result = {
  before,
  contentWidth,
  editorWidth,
  toolbarRight,
  editorRight,
  lineWidth: line.getBoundingClientRect().width,
  embedWidth: embed.getBoundingClientRect().width,
  viewerWidth: embed.firstElementChild?.getBoundingClientRect().width,
  pagesWidth: pages.getBoundingClientRect().width,
  zoomScrollWidth,
  zoomClientWidth,
  fitScrollWidth,
  contained: before <= Math.ceil(editorWidth)
    && contentWidth <= Math.ceil(editorWidth)
    && toolbarRight <= editorRight + 0.5
    && zoomScrollWidth > zoomClientWidth
    && fitScrollWidth === zoomClientWidth,
};
document.body.dataset.result = JSON.stringify(result);
document.title = result.contained ? "PASS" : "FAIL";
