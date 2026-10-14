import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{tryNative:false});
await jiti.import('../src/cli/dev.ts');
