(function(){
  var style=document.createElement('style');
  style.textContent=
    '.dc-auth-ovl{position:fixed;inset:0;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:10000;padding:1rem}'+
    '.dc-auth-ovl.open{display:flex}'+
    '.dc-auth-card{background:#fff;border-radius:20px;width:100%;max-width:360px;padding:1.75rem;box-shadow:0 24px 80px rgba(0,0,0,.15);font-family:var(--f,Inter,-apple-system,sans-serif)}'+
    '.dc-auth-tag{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--brand,#F15232);margin-bottom:.4rem}'+
    '.dc-auth-title{font-size:20px;font-weight:700;color:#1d1d1f;letter-spacing:-.3px;margin-bottom:.25rem}'+
    '.dc-auth-sub{font-size:13px;color:#6e6e73;margin-bottom:1.25rem}'+
    '.dc-auth-card input{width:100%;padding:10px 13px;border-radius:7px;border:1px solid rgba(0,0,0,.12);font-size:14px;font-family:inherit;outline:none}'+
    '.dc-auth-card input:focus{border-color:var(--brand,#F15232);box-shadow:0 0 0 3px rgba(241,82,50,.1)}'+
    '.dc-auth-btn{width:100%;margin-top:.9rem;padding:13px;border-radius:7px;border:none;background:var(--brand,#F15232);color:#fff;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer}'+
    '.dc-auth-btn:disabled{opacity:.5;cursor:not-allowed}'+
    '.dc-auth-cancel{width:100%;margin-top:.5rem;padding:10px;border:none;background:none;color:#6e6e73;font-size:13px;font-family:inherit;cursor:pointer}'+
    '.dc-auth-err{min-height:18px;margin-top:.6rem;font-size:12px;color:#c0392b;text-align:center}';
  document.head.appendChild(style);

  var ovl=null,input=null,btn=null,err=null,pending=null;

  function build(){
    if(ovl)return;
    ovl=document.createElement('div');
    ovl.className='dc-auth-ovl';
    ovl.innerHTML=
      '<div class="dc-auth-card">'+
        '<div class="dc-auth-tag">Team access</div>'+
        '<div class="dc-auth-title">Sign in</div>'+
        '<div class="dc-auth-sub">Enter the team password to manage bookings and contracts.</div>'+
        '<input type="password" placeholder="Password" autocomplete="current-password"/>'+
        '<div class="dc-auth-err"></div>'+
        '<button class="dc-auth-btn" type="button">Sign in</button>'+
        '<button class="dc-auth-cancel" type="button">Cancel</button>'+
      '</div>';
    document.body.appendChild(ovl);
    input=ovl.querySelector('input');
    btn=ovl.querySelector('.dc-auth-btn');
    err=ovl.querySelector('.dc-auth-err');
    btn.addEventListener('click',submit);
    input.addEventListener('keydown',function(e){if(e.key==='Enter')submit();});
    ovl.querySelector('.dc-auth-cancel').addEventListener('click',function(){finish(false);});
  }

  function finish(ok){
    if(!pending)return;
    ovl.classList.remove('open');
    var done=pending;pending=null;
    done(ok);
  }

  async function submit(){
    if(!input.value)return;
    btn.disabled=true;btn.textContent='Signing in…';err.textContent='';
    try{
      var r=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:input.value})});
      var d=await r.json().catch(function(){return {};});
      if(r.ok&&d.status==='success'){input.value='';finish(true);}
      else err.textContent=d.error||'Could not sign in.';
    }catch(e){
      err.textContent='Could not reach the server.';
    }
    btn.disabled=false;btn.textContent='Sign in';
  }

  // Resolves true once signed in, false if the user cancels. Concurrent callers share one prompt.
  window.promptLogin=function(){
    build();
    if(pending)return new Promise(function(resolve){var prev=pending;pending=function(ok){prev(ok);resolve(ok);};});
    return new Promise(function(resolve){
      pending=resolve;
      err.textContent='';
      ovl.classList.add('open');
      input.focus();
    });
  };

  // fetch that, on a 401, asks the user to sign in and retries once.
  window.apiFetch=async function(url,opts){
    var r=await fetch(url,opts);
    if(r.status!==401)return r;
    var ok=await window.promptLogin();
    return ok?fetch(url,opts):r;
  };
})();
