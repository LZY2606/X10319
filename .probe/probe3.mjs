import { DOMParser } from '@xmldom/xmldom';
const doc = new DOMParser().parseFromString('<?xml version="1.0"?><plist version="1.0"><dict><key>x</key><string>a&bogus;b</string></dict></plist>', 'text/xml');
const str = doc.getElementsByTagName('string')[0];
console.log('children:', [...str.childNodes].map(n=>[n.nodeType,n.nodeName,JSON.stringify(n.nodeValue)]));
// what does walker see?
console.log('nodeValue[0]:', JSON.stringify(str.childNodes[0]?.nodeValue));
