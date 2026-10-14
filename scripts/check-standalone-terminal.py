import os,pty,fcntl,termios,struct,subprocess,select,time,json,re
from pathlib import Path
root=Path(__file__).resolve().parent.parent
profile=os.environ.get('SAKURA_TEST_HOME','.sakura/test-profile')
out=root/'.sakura/frontend-evidence';out.mkdir(parents=True,exist_ok=True)
checks=[]
for width in (40,60,80,120):
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,width,0,0))
    env=dict(os.environ,TERM='xterm-256color',NO_COLOR='1',SAKURA_NO_EMOJI='1')
    proc=subprocess.Popen(['node','bin/sakura.mjs','--home',profile,'tui','--theme','sakura-light'],cwd=root,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
    data=bytearray();sent=False;done=False;deadline=time.time()+60
    while time.time()<deadline:
        if select.select([master],[],[],.1)[0]:
            try:chunk=os.read(master,65536)
            except OSError:break
            if not chunk:break
            data.extend(chunk)
        decoded=data.decode('utf8',errors='replace')
        if not sent and 'Sakura Coding Agent' in decoded:
            time.sleep(.5);os.write(master,'/plan 验证中文任务在独立终端中可以生成有效计划，保持公开接口不变\r'.encode());sent=True
        if not done and 'graph valid.' in decoded:
            time.sleep(.5);os.write(master,b'\x04');done=True
        if proc.poll() is not None:break
    if proc.poll() is None:proc.terminate()
    proc.wait(timeout=10);os.close(master)
    text=data.decode('utf8',errors='replace');(out/f'tui-{width}.log').write_text(text)
    assert sent and done and proc.returncode==0, f'{width}: CLI plan did not finish, exit={proc.returncode}'
    assert 'Sakura · 就绪' in text
    assert 'Sakura Coding Agent' in text
    assert 'Update Available' not in text and '\x1b]0;π' not in text
    checks.append(dict(width=width,passed=True,standalone=True,chinesePlan=True,noPiUpdateBanner=True,exitCode=proc.returncode))
(out/'terminal-check.json').write_text(json.dumps(dict(passed=True,checks=checks),ensure_ascii=False,indent=2))
print(json.dumps(checks,ensure_ascii=False,indent=2))
