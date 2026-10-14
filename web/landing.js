const copyButton=document.getElementById('copy-install');
const command=document.getElementById('install-command');
const status=document.getElementById('copy-status');
let statusTimer;

copyButton.addEventListener('click',async()=>{
  try{
    await navigator.clipboard.writeText(command.innerText.trim());
    copyButton.textContent='已复制';
    status.textContent='启动命令已复制到剪贴板';
  }catch{
    const selection=window.getSelection();
    const range=document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent='命令已选中，请复制';
  }
  clearTimeout(statusTimer);
  statusTimer=setTimeout(()=>{
    copyButton.textContent='复制命令';
    status.textContent='';
  },2400);
});
