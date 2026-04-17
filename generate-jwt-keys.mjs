import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { appendFileSync } from 'fs';

const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
const privatePem = await exportPKCS8(privateKey);
const publicPem = await exportSPKI(publicKey);

const envFile = process.env.GITHUB_ENV;
appendFileSync(envFile, `JWT_PRIVATE_KEY<<EOF\n${privatePem}\nEOF\n`);
appendFileSync(envFile, `JWT_PUBLIC_KEY<<EOF\n${publicPem}\nEOF\n`);
console.log('JWT keys generated successfully.');