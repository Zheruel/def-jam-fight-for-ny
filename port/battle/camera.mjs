import settings from "./cameras.json" with {type:"json"};

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

// The retail one-on-one update at 0x18ae00 publishes fighter positions to the
// camera, then advances the Battle camera with the elapsed time in seconds.
export function battleCamera(kernel, venue = "V2BG_02A") {
  const memory = kernel.memory;
  const scalar = address => memory.getFloat32(address,true);
  const word = address => memory.getUint32(address,true);
  const graphics = word(0x3fdab0);
  const projection = word(graphics + 0x38);
  const output = new Float32Array(16);
  function reset() {
    const parameters = settings[venue];
    if (!parameters) throw new Error("Missing camera settings for " + venue);
    parameters.forEach((value,index) => memory.setFloat32(0x498c60 + index*4,value,true));
  }
  reset();
  function step(seconds = 1/60) {
    kernel.call(0x2dd1d8,0x43d6a8,0,0,0);
    kernel.callWithDelta(0x1ae8b8,0x4732a4,seconds);
  }
  function matrix() {
    const eye = 0x43d610, target = 0x43d620, up = 0x43d630;
    const ex = scalar(eye), ey = scalar(eye+4), ez = scalar(eye+8);
    const dx = ex-scalar(target), dy = ey-scalar(target+4), dz = ez-scalar(target+8);
    const length = Math.hypot(dx,dy,dz);
    const x = dx/length, y = dy/length, z = dz/length;
    const ux = scalar(up), uy = scalar(up+4), uz = scalar(up+8);
    const sx = uy*z-uz*y, sy = uz*x-ux*z, sz = ux*y-uy*x;
    const rightLength = Math.hypot(sx,sy,sz);
    const rx = sx/rightLength, ry = sy/rightLength, rz = sz/rightLength;
    const tx = y*rz-z*ry, ty = z*rx-x*rz, tz = x*ry-y*rx;
    const fx = 1/Math.tan(scalar(projection+0x10)*Math.PI/360);
    const fy = fx*4/3, near = scalar(projection+0x28), far = scalar(projection+0x2c);
    const depth = -(far+near)/(far-near);
    const moveX = -(rx*ex+ry*ey+rz*ez);
    const moveY = -(tx*ex+ty*ey+tz*ez)-scalar(graphics+0x84);
    const moveZ = -(x*ex+y*ey+z*ez);
    output.set([rx*fx,tx*fy,x*depth,-x, ry*fx,ty*fy,y*depth,-y, rz*fx,tz*fy,z*depth,-z,
      moveX*fx,moveY*fy,moveZ*depth-2*near*far/(far-near),-moveZ]);
    return output;
  }
  return {step,matrix,reset};
}
