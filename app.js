const imageWrap = document.querySelector("#skyImageWrap");
const viewport = document.querySelector("#skyViewport");
const image = document.querySelector("#skyImage");
const fitsCanvas = document.querySelector("#fitsCanvas");
const fitsContext = fitsCanvas.getContext("2d");
const zoomReadout = document.querySelector("#zoomReadout");
const coverageMessage = document.querySelector("#coverageMessage");
const coordinateForm = document.querySelector("#coordinateForm");
const coordinateInput = document.querySelector("#coordinateInput");
const targetSelect = document.querySelector("#targetSelect");
const targetName = document.querySelector("#targetName");
const targetNote = document.querySelector("#targetNote");
const metadataCoordinates = document.querySelector("#metadataCoordinates");
const viewCoordinates = document.querySelector("#viewCoordinates");
const dataState = document.querySelector("#dataState");
const timeline = document.querySelector("#timeline");
const timelineLabel = document.querySelector("#timelineLabel");
const modeStatus = document.querySelector("#modeStatus");
const playButton = document.querySelector("#playButton");
const bandSelect = document.querySelector("#bandSelect");
const shareButton = document.querySelector("#shareButton");
const resourceSearch = document.querySelector("#resourceSearch");
const resourceFilter = document.querySelector("#resourceFilter");
const resourceCount = document.querySelector("#resourceCount");
const resourceLinks = [...document.querySelectorAll(".resource-link")];

const targets = {
  barnard: { name: "Barnard's Star", coordinates: "17h 57m 48.5s, +04d 41m 36s", note: "A high-proper-motion red dwarf. Use IRSA to verify available SPHEREx epochs." },
  epsilon: { name: "Epsilon Indi B", coordinates: "22h 04m 10.5s, −56d 47m 11s", note: "A nearby brown dwarf system. Coverage is not assumed until the archive returns a match." },
  wise0855: { name: "WISE 0855", coordinates: "08h 55m 10.831s, −07d 14m 42.53s", note: "A nearby cold brown dwarf. Kept as a search target; coverage must be verified in IRSA." },
  rwaurigae: { name: "RW Aurigae", coordinates: "05h 07m 49.6s, +30d 24m 05s", note: "A young variable system in Auriga. Query the archive for time-separated observations." },
  rdraconis: { name: "R Draconis", coordinates: "16h 32m 40.2s, +66d 45m 35s", note: "A variable star in Draco. A real light curve requires archive products, not a visual guess." },
};

let zoom = 1;
let offsetX = 0;
let offsetY = 0;
let dragging = false;
let startX = 0;
let startY = 0;
let playing = false;
let referenceImageSource = image.src;
let observations = [];
let currentObservation = 0;
let blinkTimer = null;
let queryInFlight = false;

function renderTransform() {
  imageWrap.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
  zoomReadout.textContent = `${zoom.toFixed(1)}×`;
}

function setZoom(nextZoom, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
  const clamped = Math.min(4, Math.max(1, nextZoom));
  if (clamped === zoom) return;
  const ratio = clamped / zoom;
  offsetX = anchorX - (anchorX - offsetX) * ratio;
  offsetY = anchorY - (anchorY - offsetY) * ratio;
  zoom = clamped;
  renderTransform();
  if (zoom >= 2.5 && !observations.length && !queryInFlight) loadTargetData();
}

function resetView() {
  zoom = 1;
  offsetX = 0;
  offsetY = 0;
  renderTransform();
}

function setTarget(key) {
  const target = targets[key];
  if (!target) return;
  targetName.textContent = target.name;
  targetNote.textContent = target.note;
  metadataCoordinates.innerHTML = target.coordinates.replace(", ", "<br />");
  coordinateInput.value = target.coordinates;
  viewCoordinates.textContent = `RA ${target.coordinates.split(",")[0]} · DEC ${target.coordinates.split(",")[1].trim()}`;
  dataState.textContent = key === "wise0855" ? "REFERENCE LOADED" : "ARCHIVE CHECK NEEDED";
  dataState.style.color = key === "wise0855" ? "var(--green)" : "var(--orange)";
  coverageMessage.hidden = key === "wise0855";
  if (key !== "wise0855") {
    modeStatus.textContent = "No SPHEREx observations loaded for this target. Open IRSA to query coverage.";
  } else {
    modeStatus.textContent = "One public reference image loaded. Add archive dates to compare.";
  }
}

function parseCoordinates(value) {
  const numbers = value.match(/[+-]?\d+(?:\.\d+)?/g);
  return numbers?.length >= 2 ? numbers : null;
}

function rightAscensionToDegrees(value) {
  const parts = value.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)?\D*(\d+(?:\.\d+)?)?/);
  if (!parts) return Number(value);
  return (Number(parts[1]) + Number(parts[2] || 0) / 60 + Number(parts[3] || 0) / 3600) * 15;
}

function declinationToDegrees(value) {
  const sign = value.trim().startsWith("-") ? -1 : 1;
  const parts = value.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)?\D*(\d+(?:\.\d+)?)?/);
  if (!parts) return Number(value);
  return sign * (Number(parts[1]) + Number(parts[2] || 0) / 60 + Number(parts[3] || 0) / 3600);
}

function getCoordinateParts(value) {
  const [ra, dec] = value.split(",").map((part) => part.trim());
  if (!ra || !dec) return null;
  const raDegrees = rightAscensionToDegrees(ra);
  const decDegrees = declinationToDegrees(dec);
  return Number.isFinite(raDegrees) && Number.isFinite(decDegrees) ? [raDegrees, decDegrees] : null;
}

function findField(row, names) {
  const key = Object.keys(row).find((candidate) => names.includes(candidate.toLowerCase()));
  return key ? row[key] : "";
}

function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.rows)) return payload.rows;
  return [];
}

async function querySpherex(value) {
  const coordinates = getCoordinateParts(value);
  if (!coordinates) throw new Error("Enter RA and Dec as decimal degrees or h/m/s and d/m/s.");
  const [ra, dec] = coordinates;
  const query = new URL("https://irsa.ipac.caltech.edu/SIA");
  query.searchParams.set("POS", `CIRCLE ${ra} ${dec} 0.1`);
  query.searchParams.set("COLLECTION", "spherex_qr3");
  query.searchParams.set("RESPONSEFORMAT", "JSON");
  query.searchParams.set("MAXREC", "100");
  const response = await fetch(query);
  if (!response.ok) throw new Error(`IRSA returned HTTP ${response.status}.`);
  const rows = normalizeRows(await response.json());
  if (!rows.length) return { rows, coordinates };
  const row = rows[0];
  const accessUrl = findField(row, ["access_url", "accessurl", "url", "getdataurl"]);
  return {
    rows,
    coordinates,
    accessUrl,
    date: findField(row, ["t_min", "date_obs", "obs_date", "observation_date"]),
    band: findField(row, ["em_min", "em_max", "band", "filter"]),
    exposure: findField(row, ["exptime", "exposure", "exposure_time"]),
    quality: findField(row, ["quality", "data_quality", "s_region"]),
  };
}

function showNoCoverage(message) {
  coverageMessage.hidden = false;
  dataState.textContent = "NO COVERAGE";
  dataState.style.color = "var(--orange)";
  modeStatus.textContent = message;
}

function drawPixels(pixels, width, height, differencePixels = null) {
  const output = fitsContext.createImageData(width, height);
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < pixels.length; index += 1) {
    const value = differencePixels ? Math.abs(pixels[index] - differencePixels[index]) : pixels[index];
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const range = max - min || 1;
  for (let index = 0; index < pixels.length; index += 1) {
    const value = differencePixels ? Math.abs(pixels[index] - differencePixels[index]) : pixels[index];
    const normalized = Math.max(0, Math.min(255, ((value - min) / range) * 255));
    const offset = index * 4;
    output.data[offset] = normalized * 0.74;
    output.data[offset + 1] = normalized * 0.84;
    output.data[offset + 2] = normalized;
    output.data[offset + 3] = 255;
  }
  fitsCanvas.width = width;
  fitsCanvas.height = height;
  fitsContext.putImageData(output, 0, 0);
}

function renderObservation(index = currentObservation) {
  const observation = observations[index];
  if (!observation?.pixels) return;
  currentObservation = index;
  const mode = document.querySelector(".mode-button.active")?.dataset.mode || "normal";
  const compare = observations[(index + 1) % observations.length];
  drawPixels(observation.pixels, observation.width, observation.height, mode === "difference" && compare?.pixels ? compare.pixels : null);
  timeline.value = index;
  timelineLabel.textContent = observation.date || `Observation ${index + 1}`;
}

function loadFitsObservation(observation) {
  return new Promise((resolve, reject) => {
    const source = observation.url;
    if (!window.astro?.FITS) {
      reject(new Error("FITS.js did not load."));
      return;
    }
    new window.astro.FITS(source, function onFitsLoaded() {
      try {
        const hdu = this.getHDU();
        const data = hdu.data;
        const axes = hdu.axes || [];
        const width = axes[0] || Math.sqrt(data.length);
        const height = axes[1] || Math.ceil(data.length / width);
        observation.pixels = data;
        observation.width = width;
        observation.height = height;
        resolve(observation);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function loadTargetData() {
  if (queryInFlight) return;
  queryInFlight = true;
  const value = coordinateInput.value;
  coverageMessage.hidden = true;
  dataState.textContent = "QUERYING IRSA";
  dataState.style.color = "var(--blue)";
  modeStatus.textContent = "Querying the official IRSA SPHEREx SIA2 service…";
  try {
    const result = await querySpherex(value);
    if (!result.rows.length) {
      showNoCoverage("No SPHEREx observations available for this region/time.");
      return;
    }
    observations = result.rows.map((row, index) => ({
      url: findField(row, ["access_url", "accessurl", "url", "getdataurl"]),
      date: findField(row, ["t_min", "date_obs", "obs_date", "observation_date"]) || `Observation ${index + 1}`,
      row,
    })).filter((observation) => observation.url);
    timeline.max = Math.max(0, observations.length - 1);
    timeline.value = 0;
    dataState.textContent = "IRSA MATCH";
    dataState.style.color = "var(--green)";
    metadataCoordinates.innerHTML = `${result.coordinates[0].toFixed(6)}°<br />${result.coordinates[1].toFixed(6)}°`;
    document.querySelector("#metadataDate").textContent = result.date || "Returned by IRSA";
    document.querySelector("#metadataBand").textContent = result.band || "Returned by IRSA";
    document.querySelector("#metadataQuality").textContent = [result.exposure, result.quality].filter(Boolean).join(" · ") || "Returned by IRSA";
    modeStatus.textContent = `${observations.length} SPHEREx observation${observations.length === 1 ? "" : "s"} returned by IRSA. Loading FITS image data…`;
    await Promise.allSettled(observations.slice(0, 4).map(loadFitsObservation));
    const loaded = observations.filter((observation) => observation.pixels);
    if (!loaded.length) throw new Error("IRSA returned records, but no browser-readable FITS image loaded.");
    observations = loaded;
    timeline.max = Math.max(0, observations.length - 1);
    imageWrap.classList.add("fits-loaded");
    renderObservation(0);
    modeStatus.textContent = `${observations.length} real FITS observation${observations.length === 1 ? "" : "s"} loaded from IRSA.`;
  } catch (error) {
    showNoCoverage(error.message);
  } finally {
    queryInFlight = false;
  }
}

coordinateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const numbers = parseCoordinates(coordinateInput.value);
  if (!numbers) {
    modeStatus.textContent = "Enter coordinates like 08h 55m 10.831s, −07d 14m 42.53s.";
    return;
  }
  viewCoordinates.textContent = `RA ${numbers[0]} · DEC ${numbers[1]}`;
  targetName.textContent = "CUSTOM SKY POSITION";
  targetNote.textContent = "Position parsed locally. Coverage and metadata still need a real IRSA archive response.";
  metadataCoordinates.innerHTML = coordinateInput.value.replace(", ", "<br />");
  dataState.textContent = "ARCHIVE CHECK NEEDED";
  dataState.style.color = "var(--orange)";
  await loadTargetData();
});

targetSelect.addEventListener("change", async () => {
  setTarget(targetSelect.value);
  await loadTargetData();
});
for (let band = 1; band <= 102; band += 1) {
  const option = document.createElement("option");
  option.value = `band-${band}`;
  option.textContent = `BAND ${String(band).padStart(3, "0")}`;
  bandSelect.append(option);
}
bandSelect.addEventListener("change", () => {
  modeStatus.textContent = bandSelect.value === "all"
    ? "All 102 bands are represented by the public NASA composite reference."
    : `${bandSelect.options[bandSelect.selectedIndex].text} selected. A true band image requires an IRSA cutout response.`;
});
shareButton.addEventListener("click", async () => {
  const url = new URL(window.location.href);
  url.searchParams.set("ra-dec", coordinateInput.value);
  try {
    if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(url.toString());
    shareButton.textContent = "SEARCH URL COPIED";
  } catch (error) {
    shareButton.textContent = "COPY BLOCKED · USE ADDRESS BAR";
  }
  setTimeout(() => { shareButton.textContent = "COPY SHAREABLE SEARCH URL"; }, 1800);
});
document.querySelector("#zoomIn").addEventListener("click", () => setZoom(zoom + 0.25));
document.querySelector("#zoomOut").addEventListener("click", () => setZoom(zoom - 0.25));
document.querySelector("#resetView").addEventListener("click", resetView);

viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  const bounds = viewport.getBoundingClientRect();
  setZoom(zoom + (event.deltaY < 0 ? 0.2 : -0.2), event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });

viewport.addEventListener("pointerdown", (event) => {
  dragging = true;
  startX = event.clientX - offsetX;
  startY = event.clientY - offsetY;
  viewport.classList.add("dragging");
  viewport.setPointerCapture(event.pointerId);
});
viewport.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  offsetX = event.clientX - startX;
  offsetY = event.clientY - startY;
  renderTransform();
});
viewport.addEventListener("pointerup", () => {
  dragging = false;
  viewport.classList.remove("dragging");
});
viewport.addEventListener("pointercancel", () => {
  dragging = false;
  viewport.classList.remove("dragging");
});

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mode-button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const mode = button.dataset.mode;
    if (blinkTimer) {
      clearInterval(blinkTimer);
      blinkTimer = null;
    }
    if (mode === "normal") {
      image.style.filter = "none";
      if (observations.length) renderObservation(currentObservation);
      modeStatus.textContent = "One public reference image loaded. Add archive dates to compare.";
    } else if (observations.length < 2) {
      image.style.filter = "none";
      modeStatus.textContent = `${button.textContent} needs two real IRSA observations. Query a region with multiple dates first.`;
      button.classList.remove("active");
      document.querySelector('[data-mode="normal"]').classList.add("active");
    } else if (mode === "blink") {
      image.style.filter = "none";
      const baseObservation = currentObservation;
      let showingNext = false;
      blinkTimer = setInterval(() => {
        showingNext = !showingNext;
        renderObservation(showingNext ? (baseObservation + 1) % observations.length : baseObservation);
      }, 520);
      modeStatus.textContent = "Blinking between two real IRSA observations.";
    } else {
      image.style.filter = "none";
      renderObservation(currentObservation);
      modeStatus.textContent = "Difference image rendered from two real IRSA FITS observations.";
    }
  });
});

function advanceTimeline() {
  if (observations.length < 2) {
    modeStatus.textContent = "Only one observation is loaded. Playback needs multiple real IRSA dates.";
    return;
  }
  playing = !playing;
  playButton.textContent = playing ? "PAUSE ▮▮" : "PLAY ▶";
  if (playing) {
    playButton.dataset.timer = setInterval(() => {
      renderObservation((currentObservation + 1) % observations.length);
    }, 850);
    modeStatus.textContent = "Playing real IRSA observation dates.";
  } else {
    clearInterval(Number(playButton.dataset.timer));
    modeStatus.textContent = "Playback paused.";
  }
}

playButton.addEventListener("click", advanceTimeline);
document.querySelector("#stepBack").addEventListener("click", () => {
  if (observations.length) renderObservation((currentObservation - 1 + observations.length) % observations.length);
});
document.querySelector("#stepForward").addEventListener("click", () => {
  if (observations.length) renderObservation((currentObservation + 1) % observations.length);
});
timeline.addEventListener("input", () => { timelineLabel.textContent = "2025 public reference"; });
timeline.addEventListener("input", () => renderObservation(Number(timeline.value)));

function filterResources() {
  const search = resourceSearch.value.trim().toLowerCase();
  const source = resourceFilter.value;
  let visible = 0;
  resourceLinks.forEach((resource) => {
    const matchesSearch = !search || resource.dataset.search.includes(search);
    const matchesSource = source === "all" || resource.dataset.source === source;
    const isVisible = matchesSearch && matchesSource;
    resource.hidden = !isVisible;
    if (isVisible) visible += 1;
  });
  resourceCount.textContent = `${visible} RESOURCE${visible === 1 ? "" : "S"}`;
}

resourceSearch.addEventListener("input", filterResources);
resourceFilter.addEventListener("change", filterResources);
image.addEventListener("error", () => {
  image.src = referenceImageSource;
  coverageMessage.hidden = false;
  dataState.textContent = "SOURCE UNAVAILABLE";
  modeStatus.textContent = "The NASA reference image could not be loaded. Open the source link to view it directly.";
});
renderTransform();