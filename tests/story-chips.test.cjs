const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8');
const body=source.slice(source.indexOf('function storyChips('),source.indexOf('\nfunction storyRow('));
function element(){return {children:[],style:{},setAttribute(k,v){this[k]=v},appendChild(c){this.children.push(c)},addEventListener(k,fn){this[k]=fn}}}
test('storyline and umbrella labels render, receive focus and navigate independently',()=>{
 const context={document:{createElement:element},chip:(text)=>Object.assign(element(),{text}),typeInfo:()=>({emoji:'',color:'#123456'}),fmtValue:()=>null,derivedMetric:()=>null,state:{campaigns:{}},canopyForStory:()=>({title:'Development',slug:'development'}),location:{}};
 vm.createContext(context);vm.runInContext(body,context);
 const wrap=context.storyChips({thread:'office-recovery'},'2026-09-11');
 assert.equal(wrap.children.length,2);
 for(const link of wrap.children){assert.equal(link.role,'link');assert.equal(link.tabIndex,0);link.click({preventDefault(){},stopPropagation(){}})}
 assert.equal(context.location.hash,'/campaign/development');
});
