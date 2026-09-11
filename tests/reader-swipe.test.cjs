const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8');
const body=source.slice(source.indexOf('// Adjacent pages are prepared'),source.indexOf('\n// a left-edge swipe'));
function fixture(){
 const timers=[],calls=[],appended=[];
 const el=()=>({style:{},classList:{add(){},remove(){}},remove(){this.removed=true}});
 const reader=el(),previous=el(),next=el();
 const ctx={state:{readerNav:{date:'2026-09-11',idx:1,list:[{id:'a'},{id:'b'},{id:'c'}]}},readerScrollPos:{},readMark:(d,id)=>d+'/'+id,readerSlideDir:0,readerStepFlash:false,readerGo:(...args)=>calls.push(args),$:()=>reader,document:{body:{append:p=>appended.push(p)}},window:{innerWidth:440,requestIdleCallback:true},requestIdleCallback(){},reducedMotion:()=>false,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length},clearTimeout(){},previous,next};
 vm.createContext(ctx);vm.runInContext(body,ctx);vm.runInContext("readerPreviewCache.set('a',previous);readerPreviewCache.set('c',next);",ctx);return {ctx,reader,previous,next,calls,timers,appended};
}
test('both full pages track finger displacement without a release-time clone',()=>{
 const {ctx,reader,next,appended}=fixture();ctx.readerDragPages(-110);assert.equal(reader.style.transform,'translate3d(-110px,0,0)');assert.equal(next.style.transform,'translate3d(330px,0,0)');assert.equal(appended.length,1);
 ctx.readerDragPages(-170);assert.equal(next.style.transform,'translate3d(270px,0,0)');assert.equal(appended.length,1);
});
test('release continues from drag position, navigates once after settling, and removes preview',()=>{
 const {ctx,reader,next,calls,timers}=fixture();ctx.readerDragPages(-220);ctx.readerSwipeStep(1,2);ctx.readerSwipeStep(1,2);
 assert.equal(reader.style.transform,'translate3d(-440px,0,0)');assert.equal(next.style.transform,'translate3d(0,0,0)');assert.equal(timers.length,1);assert.equal(timers[0].ms,110);assert.equal(calls.length,0);
 timers[0].fn();assert.deepEqual(calls,[['2026-09-11','c']]);ctx.finishReaderCarousel();assert.equal(next.removed,true);assert.equal(reader.style.transform,'');
});
test('cancel returns the page without navigation; sequence boundary creates no preview',()=>{
 const {ctx,reader,next,calls,appended}=fixture();ctx.readerDragPages(-20);ctx.cancelReaderCarousel(true);assert(next.removed);assert.equal(reader.style.transform,'translate3d(0,0,0)');assert.equal(calls.length,0);
 ctx.state.readerNav.idx=2;ctx.readerDragPages(-80);assert.equal(appended.length,1);
});
test('changing drag direction uses the other adjacent page',()=>{
 const {ctx,reader,next,previous}=fixture();ctx.readerDragPages(-80);ctx.readerDragPages(65);assert(next.removed);assert.equal(reader.style.transform,'translate3d(65px,0,0)');assert.equal(previous.style.transform,'translate3d(-375px,0,0)');
});
test('reduced motion commits without a timed slide',()=>{
 const {ctx,timers}=fixture();ctx.reducedMotion=()=>true;ctx.readerDragPages(-70);ctx.readerSwipeStep(1,1);assert.equal(timers[0].ms,0);
});
