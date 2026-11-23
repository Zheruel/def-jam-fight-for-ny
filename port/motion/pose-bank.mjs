import { fetchPacked } from "../viewer/scene.mjs";
export const capturedIdles = { V2IP_113A: 10011, V2IP_109A: 10016 };

export async function loadPoseBank(model, signal) {
  if (!Object.hasOwn(capturedIdles,model)) return null;
  const bytes = await fetchPacked(new URL(`./poses/${model}.poses.gz`,import.meta.url),signal);
  return decodePoseBank(model,bytes);
}

export function decodePoseBank(model,bytes) {
  const view = new DataView(bytes);
  if (view.getUint32(0) !== 0x444a5031) throw new Error("Invalid pose header");
  const length = view.getUint32(4,true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,8,length)));
  if (header.model !== model || header.boneCount !== 94) throw new Error("Unexpected fighter rig");
  const stride = header.boneCount * 16;
  for (const clip of Object.values(header.clips)) {
    clip.poses = clip.frames.map((_,i) => new Float32Array(bytes,8+length+clip.offset+i*stride*4,stride));
  }
  return header;
}

export function poseIndex(clip, frame) {
  let lo = 0, hi = clip.frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (clip.frames[mid] < frame) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && frame-clip.frames[lo-1] < clip.frames[lo]-frame) return lo-1;
  return lo;
}
