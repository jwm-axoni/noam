import "../../styles/tokens.css";
import "../../styles/theme-presets.css";
import "../../App.css";

const fixture = document.querySelector<HTMLElement>("#fixture");
if (!fixture) throw new Error("Missing fixture host");

fixture.style.width = "782px";
fixture.style.height = "514px";
fixture.style.display = "flex";

const viewer = document.createElement("div");
viewer.className = "image-viewer";
viewer.innerHTML = `
  <div class="image-stage fit-mode">
    <img class="fit" alt="Portrait fixture"
      src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='696' height='900'%3E%3Crect width='696' height='900' fill='%237c3aed'/%3E%3C/svg%3E" />
  </div>`;
fixture.append(viewer);

const stage = viewer.querySelector<HTMLElement>(".image-stage");
const image = viewer.querySelector<HTMLImageElement>("img");
if (!stage || !image) throw new Error("Missing image fixture parts");

const contained = () => {
  const outer = stage.getBoundingClientRect();
  const inner = image.getBoundingClientRect();
  const style = getComputedStyle(stage);
  const inset = {
    top: parseFloat(style.paddingTop),
    right: parseFloat(style.paddingRight),
    bottom: parseFloat(style.paddingBottom),
    left: parseFloat(style.paddingLeft),
  };
  return inner.top >= outer.top + inset.top - 0.5
    && inner.left >= outer.left + inset.left - 0.5
    && inner.bottom <= outer.bottom - inset.bottom + 0.5
    && inner.right <= outer.right - inset.right + 0.5;
};

const measure = () => {
  const fitContained = contained();
  const fitHeight = image.getBoundingClientRect().height;

  stage.classList.remove("fit-mode");
  image.classList.remove("fit");
  image.style.width = "125%";
  const zoomScrollable = stage.scrollHeight > stage.clientHeight
    || stage.scrollWidth > stage.clientWidth;

  image.style.removeProperty("width");
  image.classList.add("fit");
  stage.classList.add("fit-mode");
  const restoredContained = contained();

  const result = {
    natural: { width: image.naturalWidth, height: image.naturalHeight },
    stage: { width: stage.clientWidth, height: stage.clientHeight },
    fitHeight,
    fitContained,
    zoomScrollable,
    restoredContained,
    contained: fitContained && zoomScrollable && restoredContained,
  };
  document.body.dataset.result = JSON.stringify(result);
  document.title = result.contained ? "PASS" : "FAIL";
};

if (image.complete) measure();
else image.addEventListener("load", measure, { once: true });
