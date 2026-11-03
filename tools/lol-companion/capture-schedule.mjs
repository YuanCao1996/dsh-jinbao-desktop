// Chooses between the cheap card-title pass and the expensive full-frame OCR.
//
// A real match showed the capture loop spending ~1.2s per cycle with almost every cycle a
// full-frame OCR, because the old rule ran a full frame on *every* capture whenever no
// panel was on screen. Titles-only reads are enough to notice a panel appearing, and the
// full pass only re-calibrates geometry, so both states now share one gate.
export function createCaptureSchedule({now=Date.now,fullIntervalMs=2000}={}){
 let nextFull=0;
 return {
  reset(){nextFull=0;},
  choose(){
   const at=now();
   if(at<nextFull)return 'titles';
   nextFull=at+fullIntervalMs;
   return 'full';
  }};
}
