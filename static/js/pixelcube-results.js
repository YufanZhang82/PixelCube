(function () {
  "use strict";

  const SYNC_TOLERANCE = 0.10;
  const DRIFT_SYNC_INTERVAL_MS = 1000;

  function pad2(num) {
    return String(num).padStart(2, "0");
  }

  function makeVideo(src, key, group) {
    const video = document.createElement("video");

    video.className = "pc-video";
    video.dataset.key = key;
    video.dataset.group = group;

    // No browser controls: hides progress bar, download button, volume button, etc.
    video.controls = false;
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";

    video.removeAttribute("controls");
    video.setAttribute("autoplay", "");
    video.setAttribute("muted", "");
    video.setAttribute("loop", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");

    // Reduce casual downloading / PiP. This does not fully prevent Network download.
    video.setAttribute("controlslist", "nodownload nofullscreen noremoteplayback");
    video.setAttribute("disablepictureinpicture", "");
    video.setAttribute("disableremoteplayback", "");
    video.setAttribute("oncontextmenu", "return false;");

    const source = document.createElement("source");
    source.src = src;
    source.type = "video/mp4";
    video.appendChild(source);

    video.addEventListener("loadedmetadata", () => {
      console.log("[PixelCube video loaded]", src);
    });

    video.addEventListener("error", () => {
      console.error("[PixelCube video error]", src, video.error);
    });

    source.addEventListener("error", () => {
      console.error("[PixelCube source missing or unsupported]", src);
    });

    return video;
  }

  function getActiveVideo(viewer) {
    return viewer.querySelector(".pc-video.active");
  }

  function getCreatedVideos(viewer) {
    return Array.from(viewer.querySelectorAll(".pc-video"));
  }

  function getCreatedGroupVideos(viewer, group) {
    return getCreatedVideos(viewer).filter((video) => video.dataset.group === group);
  }

  function safePlay(video) {
    if (!video) return;

    video.muted = true;
    video.defaultMuted = true;

    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => {});
    }
  }

  function clampTimeForVideo(video, time) {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;

    if (duration > 0) {
      return Math.min(Math.max(0, time), Math.max(0, duration - 0.05));
    }

    return Math.max(0, time);
  }

  function syncVideoToTime(video, time) {
    if (!video || video.readyState < 1) return;

    const safeTime = clampTimeForVideo(video, time);

    if (Math.abs(video.currentTime - safeTime) > SYNC_TOLERANCE) {
      try {
        video.currentTime = safeTime;
      } catch (error) {
        // Ignore seek errors before metadata is fully available.
      }
    }
  }

  function syncGroupToTime(viewer, group, time, excludeVideo = null) {
    getCreatedGroupVideos(viewer, group).forEach((video) => {
      if (video === excludeVideo) return;
      syncVideoToTime(video, time);
    });
  }

  function playGroup(viewer, group) {
    getCreatedGroupVideos(viewer, group).forEach((video) => {
      safePlay(video);
    });
  }

  function pauseGroup(viewer, group) {
    getCreatedGroupVideos(viewer, group).forEach((video) => {
      video.pause();
    });
  }

  function pauseNonCurrentGroups(viewer, currentGroup) {
    getCreatedVideos(viewer).forEach((video) => {
      if (video.dataset.group !== currentGroup) {
        video.pause();
      }
    });
  }

  function removeAllActiveClasses(viewer) {
    getCreatedVideos(viewer).forEach((video) => {
      video.classList.remove("active");
    });
  }

  function ensureVideoByKey(viewer, key) {
    const descriptor = viewer.__sourceByKey.get(key);

    if (!descriptor) {
      console.error("[PixelCube missing source descriptor]", key);
      return null;
    }

    let video = viewer.querySelector(`.pc-video[data-key="${key}"]`);

    if (video) {
      return video;
    }

    video = makeVideo(descriptor.src, descriptor.key, descriptor.group);
    viewer.__stage.appendChild(video);

    bindVideoSyncEvents(viewer, video);

    return video;
  }

  function ensureGroupVideos(viewer, group) {
    const descriptors = viewer.__sourceList.filter((item) => item.group === group);

    descriptors.forEach((item) => {
      ensureVideoByKey(viewer, item.key);
    });
  }

  function activateVideo(viewer, key, group) {
    ensureGroupVideos(viewer, group);

    const oldVideo = getActiveVideo(viewer);
    const newVideo = ensureVideoByKey(viewer, key);

    if (!newVideo) return;

    const referenceTime =
      oldVideo && Number.isFinite(oldVideo.currentTime) ? oldVideo.currentTime : 0;

    removeAllActiveClasses(viewer);
    newVideo.classList.add("active");

    pauseNonCurrentGroups(viewer, group);

    const syncAndPlayCurrentGroup = () => {
      const safeReferenceTime = clampTimeForVideo(newVideo, referenceTime);

      syncVideoToTime(newVideo, safeReferenceTime);
      syncGroupToTime(viewer, group, newVideo.currentTime, newVideo);
      playGroup(viewer, group);
    };

    if (newVideo.readyState >= 1) {
      syncAndPlayCurrentGroup();
    } else {
      newVideo.addEventListener("loadedmetadata", syncAndPlayCurrentGroup, { once: true });
      newVideo.load();
    }
  }

  function bindVideoSyncEvents(viewer, video) {
    video.addEventListener("play", () => {
      if (viewer.__internalSync) return;
      if (!video.classList.contains("active")) return;

      const group = video.dataset.group;

      viewer.__internalSync = true;
      playGroup(viewer, group);
      viewer.__internalSync = false;
    });

    video.addEventListener("pause", () => {
      if (viewer.__internalSync) return;
      if (!video.classList.contains("active")) return;

      const group = video.dataset.group;

      viewer.__internalSync = true;
      pauseGroup(viewer, group);
      viewer.__internalSync = false;
    });

    video.addEventListener("seeked", () => {
      if (viewer.__internalSync) return;
      if (!video.classList.contains("active")) return;

      const group = video.dataset.group;

      viewer.__internalSync = true;
      syncGroupToTime(viewer, group, video.currentTime, video);
      playGroup(viewer, group);
      viewer.__internalSync = false;
    });
  }

  function bindPeriodicDriftCorrection(viewer) {
    window.setInterval(() => {
      const activeVideo = getActiveVideo(viewer);
      if (!activeVideo || activeVideo.paused) return;

      const group = activeVideo.dataset.group;
      syncGroupToTime(viewer, group, activeVideo.currentTime, activeVideo);
    }, DRIFT_SYNC_INTERVAL_MS);
  }

  function createButton(label, value, className, controlName) {
    const btn = document.createElement("button");

    btn.type = "button";
    btn.className = className;
    btn.dataset.value = value;
    btn.dataset.control = controlName;
    btn.textContent = label;

    return btn;
  }

  function setControlActive(viewer, controlName, value) {
    viewer
      .querySelectorAll(`[data-control="${controlName}"]`)
      .forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.value === value);
      });
  }

  function createViewer({
    root,
    state,
    modes,
    subjects,
    lightingOptions,
    backgroundOptions,
    getVideoKey,
    getGroupKey,
    getVideoSources,
    onPrev,
    onNext,
    showArrows = true,
    note = ""
  }) {
    const viewer = document.createElement("div");
    viewer.className = "pc-viewer";

    viewer.__sourceList = getVideoSources();
    viewer.__sourceByKey = new Map();
    viewer.__internalSync = false;

    viewer.__sourceList.forEach((item) => {
      viewer.__sourceByKey.set(item.key, item);
    });

    const controlsTop = document.createElement("div");
    controlsTop.className = "pc-controls pc-controls-top";

    const controlsBottom = document.createElement("div");
    controlsBottom.className = "pc-controls pc-controls-bottom";

    function addControlRow(parent, label, buttons) {
      const row = document.createElement("div");
      row.className = "pc-control-row";

      if (label) {
        const span = document.createElement("span");
        span.className = "pc-control-label";
        span.textContent = label;
        row.appendChild(span);
      }

      buttons.forEach((btn) => row.appendChild(btn));
      parent.appendChild(row);

      return row;
    }

    let subjectButtons = [];

    if (subjects && subjects.length > 0) {
      subjectButtons = subjects.map((subject, idx) => {
        return createButton(String(idx + 1), subject.value, "pc-dot-btn", "subject");
      });

      // Subject buttons are placed above the video.
      addControlRow(controlsTop, "Subject", subjectButtons);
    }

    const stageWrap = document.createElement("div");
    stageWrap.className = "pc-stage-wrap";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "pc-nav-arrow";
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "pc-nav-arrow";
    nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';

    const stage = document.createElement("div");
    stage.className = "pc-video-stage";
    viewer.__stage = stage;

    stageWrap.appendChild(prevBtn);
    stageWrap.appendChild(stage);
    stageWrap.appendChild(nextBtn);

    if (!showArrows) {
      prevBtn.style.visibility = "hidden";
      nextBtn.style.visibility = "hidden";
    }

    const modeButtons = modes.map((mode) => {
      return createButton(mode.label, mode.value, "pc-switch-btn", "mode");
    });

    // No "View" label.
    addControlRow(controlsBottom, "", modeButtons);

    let lightingButtons = [];

    if (lightingOptions && lightingOptions.length > 0) {
      lightingButtons = lightingOptions.map((lighting) => {
        return createButton(lighting.label, lighting.value, "pc-switch-btn", "lighting");
      });

      // No "Lighting" label under the video.
      addControlRow(controlsBottom, "", lightingButtons);
    }

    let backgroundButtons = [];

    if (backgroundOptions && backgroundOptions.length > 0) {
      backgroundButtons = backgroundOptions.map((bg) => {
        return createButton(bg.label, bg.value, "pc-switch-btn", "background");
      });

      // No "Background" label under the video.
      addControlRow(controlsBottom, "", backgroundButtons);
    }

    if (note) {
      const noteEl = document.createElement("div");
      noteEl.className = "pc-card-note";
      noteEl.textContent = note;
      controlsBottom.appendChild(noteEl);
    }

    viewer.appendChild(controlsTop);
    viewer.appendChild(stageWrap);
    viewer.appendChild(controlsBottom);
    root.appendChild(viewer);

    function update() {
      const activeKey = getVideoKey();
      const activeGroup = getGroupKey();

      activateVideo(viewer, activeKey, activeGroup);

      setControlActive(viewer, "mode", state.mode);

      if (state.subject) {
        setControlActive(viewer, "subject", state.subject);
      }

      if (state.lighting) {
        setControlActive(viewer, "lighting", state.lighting);
      }

      if (state.background) {
        setControlActive(viewer, "background", state.background);
      }
    }

    modeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mode = btn.dataset.value;
        update();
      });
    });

    subjectButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.subject = btn.dataset.value;
        update();
      });
    });

    lightingButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.lighting = btn.dataset.value;
        update();
      });
    });

    backgroundButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        state.background = btn.dataset.value;
        update();
      });
    });

    prevBtn.addEventListener("click", () => {
      if (typeof onPrev === "function") {
        onPrev();
      }

      update();
    });

    nextBtn.addEventListener("click", () => {
      if (typeof onNext === "function") {
        onNext();
      }

      update();
    });

    bindPeriodicDriftCorrection(viewer);
    update();
  }

  function initDelight() {
    const root = document.getElementById("pixelcube-delight-root");
    if (!root) return;

    const subjects = Array.from({ length: 10 }, (_, i) => {
      const id = `subject${pad2(i + 1)}`;

      return {
        value: id,
        label: `Subject ${i + 1}`,
        basePath: `static/videos/delight/${id}`
      };
    });

    const state = {
      mode: "origin",
      subject: subjects[0].value
    };

    function subjectIndex() {
      return subjects.findIndex((s) => s.value === state.subject);
    }

    createViewer({
      root,
      state,
      modes: [
        { label: "Original", value: "origin" },
        { label: "Delight", value: "delight" }
      ],
      subjects,
      getVideoKey: () => `${state.subject}-${state.mode}`,
      getGroupKey: () => state.subject,
      getVideoSources: () => {
        const sources = [];

        subjects.forEach((subject) => {
          sources.push({
            key: `${subject.value}-origin`,
            group: subject.value,
            src: `${subject.basePath}/origin.mp4`
          });

          sources.push({
            key: `${subject.value}-delight`,
            group: subject.value,
            src: `${subject.basePath}/delight.mp4`
          });
        });

        return sources;
      },
      onPrev: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx - 1 + subjects.length) % subjects.length].value;
      },
      onNext: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx + 1) % subjects.length].value;
      }
    });
  }

  function initRelightDiverse() {
    const root = document.getElementById("pixelcube-relight-diverse-root");
    if (!root) return;

    const subjects = Array.from({ length: 6 }, (_, i) => {
      const id = `scene${pad2(i + 1)}`;

      return {
        value: id,
        label: `Scene ${i + 1}`,
        basePath: `static/videos/relight/diverse/${id}`
      };
    });

    const state = {
      mode: "origin",
      subject: subjects[0].value
    };

    function subjectIndex() {
      return subjects.findIndex((s) => s.value === state.subject);
    }

    createViewer({
      root,
      state,
      modes: [
        { label: "Original", value: "origin" },
        { label: "Relight", value: "relight" }
      ],
      subjects,
      getVideoKey: () => `${state.subject}-${state.mode}`,
      getGroupKey: () => state.subject,
      getVideoSources: () => {
        const sources = [];

        subjects.forEach((subject) => {
          sources.push({
            key: `${subject.value}-origin`,
            group: subject.value,
            src: `${subject.basePath}/origin.mp4`
          });

          sources.push({
            key: `${subject.value}-relight`,
            group: subject.value,
            src: `${subject.basePath}/relight.mp4`
          });
        });

        return sources;
      },
      onPrev: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx - 1 + subjects.length) % subjects.length].value;
      },
      onNext: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx + 1) % subjects.length].value;
      }
    });
  }

  function initRelightDynamic() {
    const root = document.getElementById("pixelcube-relight-dynamic-root");
    if (!root) return;

    // Changed from 4 dynamic examples to 3 dynamic examples.
    const subjects = Array.from({ length: 3 }, (_, i) => {
      const id = `dynamic${pad2(i + 1)}`;

      return {
        value: id,
        label: `Dynamic ${i + 1}`,
        basePath: `static/videos/relight/dynamic/${id}`
      };
    });

    const lightingOptions = [
      {
        label: "Envmap",
        value: "envmap",
        filename: "relight_envmap.mp4"
      },
      {
        label: "Color Light 1",
        value: "color1",
        filename: "relight_color1.mp4"
      },
      {
        label: "Color Light 2",
        value: "color2",
        filename: "relight_color2.mp4"
      }
    ];

    const state = {
      mode: "origin",
      subject: subjects[0].value,
      lighting: lightingOptions[0].value
    };

    function subjectIndex() {
      return subjects.findIndex((s) => s.value === state.subject);
    }

    createViewer({
      root,
      state,
      modes: [
        { label: "Original", value: "origin" },
        { label: "Relight", value: "relight" }
      ],
      subjects,
      lightingOptions,
      getVideoKey: () => {
        if (state.mode === "origin") {
          return `${state.subject}-origin`;
        }

        return `${state.subject}-${state.lighting}`;
      },
      getGroupKey: () => state.subject,
      getVideoSources: () => {
        const sources = [];

        subjects.forEach((subject) => {
          sources.push({
            key: `${subject.value}-origin`,
            group: subject.value,
            src: `${subject.basePath}/origin.mp4`
          });

          lightingOptions.forEach((lighting) => {
            sources.push({
              key: `${subject.value}-${lighting.value}`,
              group: subject.value,
              src: `${subject.basePath}/${lighting.filename}`
            });
          });
        });

        return sources;
      },
      onPrev: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx - 1 + subjects.length) % subjects.length].value;
      },
      onNext: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx + 1) % subjects.length].value;
      }
    });
  }

  function initRelightBackground() {
    const root = document.getElementById("pixelcube-relight-background-root");
    if (!root) return;

    const subjects = Array.from({ length: 3 }, (_, i) => {
      const id = `identity${pad2(i + 1)}`;

      return {
        value: id,
        label: `Identity ${i + 1}`,
        basePath: `static/videos/relight/background/${id}`
      };
    });

    const backgroundOptions = [
      {
        label: "Scene 1",
        value: "scene1",
        filename: "relight_scene1.mp4"
      },
      {
        label: "Scene 2",
        value: "scene2",
        filename: "relight_scene2.mp4"
      },
      {
        label: "Scene 3",
        value: "scene3",
        filename: "relight_scene3.mp4"
      },
      {
        label: "Scene 4",
        value: "scene4",
        filename: "relight_scene4.mp4"
      }
    ];

    const state = {
      mode: "relight",
      subject: subjects[0].value,
      background: backgroundOptions[0].value
    };

    function subjectIndex() {
      return subjects.findIndex((s) => s.value === state.subject);
    }

    createViewer({
      root,
      state,
      modes: [
        { label: "Original", value: "origin" },
        { label: "Relight", value: "relight" }
      ],
      subjects,
      backgroundOptions,
      getVideoKey: () => {
        if (state.mode === "origin") {
          return `${state.subject}-origin`;
        }

        return `${state.subject}-${state.background}`;
      },
      getGroupKey: () => state.subject,
      getVideoSources: () => {
        const sources = [];

        subjects.forEach((subject) => {
          sources.push({
            key: `${subject.value}-origin`,
            group: subject.value,
            src: `${subject.basePath}/origin.mp4`
          });

          backgroundOptions.forEach((bg) => {
            sources.push({
              key: `${subject.value}-${bg.value}`,
              group: subject.value,
              src: `${subject.basePath}/${bg.filename}`
            });
          });
        });

        return sources;
      },
      onPrev: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx - 1 + subjects.length) % subjects.length].value;
      },
      onNext: () => {
        const idx = subjectIndex();
        state.subject = subjects[(idx + 1) % subjects.length].value;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initDelight();
    initRelightDiverse();
    initRelightDynamic();
    initRelightBackground();
  });
})();