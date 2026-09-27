const panel=document.createElement('dialog');
panel.innerHTML='<h2>Your private testing workspace</h2><p id="cloud-message">Enter the access code supplied by the project owner. Files stay in your isolated cloud session, which expires after 45 minutes.</p><form><label>Access code <input type="password" name="code" minlength="8" required autocomplete="off"></label><p><button class="primary-button">Start cloud workspace</button></p></form><p id="cloud-error" role="alert"></p>';
panel.insertAdjacentHTML('beforeend','<p><a href="/evidence.html">View real recorded test &amp; repair evidence — no key needed</a></p>');
document.body.append(panel);panel.showModal();
panel.addEventListener('cancel',event=>event.preventDefault());
const message=panel.querySelector('#cloud-message'),error=panel.querySelector('#cloud-error'),form=panel.querySelector('form');
async function connect(code) {
  const response=await fetch('/api/cloud?action=init',{method:'POST',headers:{'content-type':'application/json','x-proofrun':'1'},body:JSON.stringify({code})});
  const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}
async function wait(code) {
  let data=await connect(code);form.hidden=true;
  for(let attempt=0;attempt<180;attempt++) {
    message.textContent=data.message;
    if(data.failed)throw new Error(data.message);
    if(data.ready){panel.close();panel.remove();await import('./workbench.js');return;}
    await new Promise(resolve=>setTimeout(resolve,4000));data=await connect();
  }
  throw new Error('Cloud setup exceeded 12 minutes. Check the deployment logs before trying again.');
}
form.addEventListener('submit',async event=>{event.preventDefault();error.textContent='';form.querySelector('button').disabled=true;try{await wait(form.elements.code.value);}catch(e){error.textContent=e.message;form.hidden=false;form.querySelector('button').disabled=false;}});
try {const data=await connect();if(data.ready){panel.close();panel.remove();await import('./workbench.js');}else{await wait();}}catch(e){if(!/access code/i.test(e.message))error.textContent=e.message;}
