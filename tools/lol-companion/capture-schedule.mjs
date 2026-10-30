export function createCaptureSchedule({now=Date.now}={}){
 let nextFull=0;
 return {reset(){nextFull=0;},choose(knownSlots){
  const at=now();
  if(knownSlots>=2&&at<nextFull)return 'titles';
  nextFull=at+2000;return 'full';
 }};
}
