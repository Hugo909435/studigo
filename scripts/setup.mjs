import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

try { await access(new URL('../.env',import.meta.url)); console.log('.env existe déjà. Configuration conservée.'); }
catch {
  const prompt=createInterface({input:process.stdin,output:process.stdout});
  let password='';
  try {
    console.log('Choisis le mot de passe du studio (16 caractères minimum). La saisie est visible dans ce terminal.');
    while(password.length<16) password=(await prompt.question('Mot de passe : ')).trim();
  } finally { prompt.close(); }
  const template=await readFile(new URL('../.env.example',import.meta.url),'utf8');
  const quoted=JSON.stringify(password);
  await writeFile(new URL('../.env',import.meta.url),template.replace(/^ADMIN_PASSWORD=$/m,`ADMIN_PASSWORD=${quoted}`).replace(/^MEDIA_SECRET=$/m,`MEDIA_SECRET=${randomBytes(32).toString('hex')}`),{flag:'wx',mode:0o600});
  console.log('Configuration locale créée. Lance npm start.');
}
