import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { appendFileSync } from 'fs';

const { privateKey, publicKey } = await generateKeyPair('RS256', { 
  modulusLength: 2048, 
  extractable: true 
});

const privatePem = (await exportPKCS8(privateKey)).trim(); // 👈 trim()
const publicPem = (await exportSPKI(publicKey)).trim();    // 👈 trim()

const envFile = process.env.GITHUB_ENV;
if (!envFile) throw new Error('GITHUB_ENV is not defined');

appendFileSync(envFile, `JWT_PRIVATE_KEY<<EOF\n${privatePem}\nEOF\n`);
appendFileSync(envFile, `JWT_PUBLIC_KEY<<EOF\n${publicPem}\nEOF\n`);

console.log('JWT keys generated successfully.');