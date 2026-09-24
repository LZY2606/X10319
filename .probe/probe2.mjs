import { DOMParser } from '@xmldom/xmldom';
function tryParse(xml, label) {
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    console.log(label, 'root=', doc.documentElement?.nodeName);
  } catch (e) { console.log(label, 'throws:', String(e.message).split('\n').slice(0,2).join(' | ')); }
}
tryParse('this is not xml at all', 'garbage');
tryParse('<?xml version="1.0"?><plist version="1.0"><dict><key>x</key><string>&bogus;</string></dict></plist>', 'bad-entity');
tryParse('<?xml version="1.0"?><plist version="1.0"><dict><key>x</key><string>a</dict></plist>', 'unclosed');
tryParse('<?xml version="1.0"?><plist version="1.0"><dict><key>x</key><string>a</string></plist>', 'ok');

const doc = new DOMParser().parseFromString(
'<?xml version="1.0"?><plist version="1.0"><dict><key><!--c-->foo</key><string>a&#13;b</string><data>AA\r\nBB</data></dict></plist>', 'text/xml');
const key = doc.getElementsByTagName('key')[0];
console.log('key types:', [...key.childNodes].map(n=>n.nodeType), 'values:', [...key.childNodes].map(n=>JSON.stringify(n.nodeValue)));
const str = doc.getElementsByTagName('string')[0];
console.log('string value:', JSON.stringify(str.childNodes[0].nodeValue), 'hasCR:', str.childNodes[0].nodeValue.includes('\r'));
const data = doc.getElementsByTagName('data')[0];
console.log('data raw value:', JSON.stringify(data.childNodes[0].nodeValue));
