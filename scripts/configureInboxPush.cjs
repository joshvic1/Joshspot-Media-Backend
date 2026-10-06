const fs=require('node:fs');const path=require('node:path');const webpush=require('web-push');
const file=path.join(__dirname,'../.env');const source=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
const has=key=>new RegExp('^'+key+'=.+$','m').test(source);
if(has('INBOX_PUSH_PUBLIC_KEY')||has('INBOX_PUSH_PRIVATE_KEY')){console.log('Push keys already exist. Preserve the pair; do not rotate without renewing browser subscriptions.');process.exit(0)}
const keys=webpush.generateVAPIDKeys();let content=source.replace(/^INBOX_PUSH_(PUBLIC_KEY|PRIVATE_KEY)=.*\r?\n?/gm,'');
content+='\nINBOX_PUSH_PUBLIC_KEY='+keys.publicKey+'\nINBOX_PUSH_PRIVATE_KEY='+keys.privateKey+'\n';
if(!has('INBOX_PUSH_SUBJECT'))content+='INBOX_PUSH_SUBJECT=mailto:admin@joshspotmedia.com\n';
fs.writeFileSync(file,content);console.log('Saved the push signing keys privately in backend .env. Copy INBOX_PUSH_PUBLIC_KEY, INBOX_PUSH_PRIVATE_KEY and INBOX_PUSH_SUBJECT to Railway. No credentials printed.');
