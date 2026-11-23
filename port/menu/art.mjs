// Lazy loader for the selector art (port/menu/art, exported by extract.py): a picture is fetched the first time it is
// drawn, so the menu only ever downloads what is on screen.
const base = new URL("./art/", import.meta.url);
const cache = new Map();

export function picture(name) {
  if (!cache.has(name)) {
    cache.set(name, fetch(new URL(name, base)).then(async response => {
      if (!response.ok) throw new Error(`Unable to load menu art ${name}`);
      return createImageBitmap(await response.blob());
    }));
  }
  return cache.get(name);
}

// Synchronous view for the draw loop: undefined until the picture has arrived (and a load is started).
const ready = new Map();
export function have(name) {
  if (!ready.has(name)) {
    ready.set(name, undefined);
    picture(name).then(bitmap => { ready.set(name, bitmap); changed(); }).catch(() => ready.set(name, null));
  }
  return ready.get(name) ?? undefined;
}

let listener = () => {};
export const onArrive = fn => { listener = fn; };
const changed = () => listener();

export const fighterPictures = id => [`fighters/${id}-h.png`, `fighters/${id}-c.png`, `fighters/${id}-n.png`];
