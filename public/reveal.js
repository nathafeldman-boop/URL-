/* Révèle en fondu les éléments .reveal quand ils entrent dans le viewport,
   déclenche les surlignages .hl, et fait "s'écrire" en direct la démo
   d'exemple (voir #exemple sur la landing). */
(function () {
  const noMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasIO = "IntersectionObserver" in window;

  const revealEls = document.querySelectorAll(".reveal");
  if (!hasIO || noMotion) {
    revealEls.forEach((el) => el.classList.add("in"));
  } else if (revealEls.length) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -60px 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  }

  /* ------------------------------------------------------- surlignage blanc */
  const hlEls = document.querySelectorAll(".hl");
  if (!hasIO || noMotion) {
    hlEls.forEach((el) => el.classList.add("in"));
  } else if (hlEls.length) {
    const hlIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            hlIo.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.6 }
    );
    hlEls.forEach((el) => hlIo.observe(el));
  }

  /* ------------------------------------------------------- démo qui s'écrit
     Vide le texte de chaque .demo-item p puis le retape caractère par
     caractère, un item après l'autre, un curseur clignotant en suivant
     la frappe — plutôt qu'un simple fondu classique. */
  const demoCard = document.querySelector(".demo");
  if (!demoCard) return;

  const items = [...demoCard.querySelectorAll(".demo-item")];
  items.forEach((item) => item.querySelector(".demo-tag")?.classList.add("demo-tag-pending"));

  if (!hasIO || noMotion) {
    items.forEach((item) => item.querySelector(".demo-tag")?.classList.add("in"));
    return;
  }

  /* Capture puis vide tout de suite (avant même que la section soit visible)
     pour que rien n'apparaisse en clair avant son tour dans la frappe. */
  function captureAndClear(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    const fulls = nodes.map((node) => node.textContent);
    nodes.forEach((node) => (node.textContent = ""));
    return { nodes, fulls };
  }

  const captured = items.map((item) => {
    const p = item.querySelector("p");
    return p ? captureAndClear(p) : null;
  });

  function typeCaptured({ nodes, fulls }, speed) {
    return new Promise((resolve) => {
      if (!nodes.length) return resolve();
      const caret = document.createElement("span");
      caret.className = "type-caret";

      let ni = 0;
      let ci = 0;
      (function tick() {
        if (ni >= nodes.length) {
          caret.remove();
          return resolve();
        }
        const node = nodes[ni];
        const full = fulls[ni];
        if (ci === 0) node.parentNode.insertBefore(caret, node.nextSibling);
        ci++;
        node.textContent = full.slice(0, ci);
        if (ci >= full.length) {
          ni++;
          ci = 0;
        }
        setTimeout(tick, speed + Math.random() * 16);
      })();
    });
  }

  const demoIo = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          demoIo.unobserve(entry.target);
          (async () => {
            for (let idx = 0; idx < items.length; idx++) {
              const tag = items[idx].querySelector(".demo-tag");
              tag?.classList.add("in");
              await new Promise((r) => setTimeout(r, 150));
              if (captured[idx]) await typeCaptured(captured[idx], 13);
              await new Promise((r) => setTimeout(r, 220));
            }
          })();
        }
      }
    },
    { threshold: 0.25 }
  );
  demoIo.observe(demoCard);
})();
