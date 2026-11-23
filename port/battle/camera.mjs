// Foundation's standard two-fighter shot. Distances and viewport calibration
// come from SLUS-21004's camera output at 0x43d610 and EAGL's projection matrix.
export function foundationCamera() {
  const target = [0,10,0];
  let radius=133.75, pitch=0.227;
  function reset() { target.splice(0,3,0,10,0); radius=133.75; pitch=0.227; }
  function step(states) {
    const [a,b]=states.map(s=>s.position);
    const separation=Math.hypot(b[0]-a[0],b[2]-a[2]);
    const center=[(a[0]+b[0])/2,(a[1]+b[1])/2+10,(a[2]+b[2])/2];
    for(let i=0;i<3;i++) target[i]+=(center[i]-target[i])*0.22;
    radius+=(Math.max(63.3,separation*2.675)-radius)*0.2;
    pitch+=(0.2443-pitch)*0.029;
  }
  function matrix() {
    const c=Math.cos(pitch),s=Math.sin(pitch);
    const [x,y,z]=target;
    // Retail viewport scales clip X and Y by 3, and applies a four-unit
    // vertical camera offset before the view transform.
    const eyeY=y+radius*s+4*c, eyeZ=z+radius*c-4*s;
    const dx=-x,dy=-c*eyeY+s*eyeZ,dz=-s*eyeY-c*eyeZ;
    const fx=3.3759,fy=4.5012,depth=-1.000137,near=-8.9999;
    return new Float32Array([fx,0,0,0, 0,fy*c,depth*s,-s, 0,-fy*s,depth*c,-c,
      dx*fx,dy*fy,dz*depth+near,-dz]);
  }
  return {reset,step,matrix};
}
