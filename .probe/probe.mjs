import { DOMParser } from '@xmldom/xmldom';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<?mypi data?>
<plist version="1.0">\r
<dict>\r
<key>a &amp; b</key>\r
<string>x&#x1F389;y &quot;q&quot;</string>\r
<key>dup</key><string>1</string><key>dup</key><string>2</string>\r
</dict>\r
</plist>`;

const doc = new DOMParser().parseFromString(xml, 'text/xml');
const plist = doc.documentElement;
function dump(node, depth=0) {
  const pad='  '.repeat(depth);
  const nt={1:'ELEMENT',3:'TEXT',4:'CDATA',7:'PI',8:'COMMENT',10:'DOC'}[node.nodeType]||node.nodeType;
  let extra='';
  if (node.nodeType===1) extra=' attrs='+JSON.stringify(node.getAttributeNames?.());
  console.log(pad+nt+' name='+node.nodeName+' value='+JSON.stringify(node.nodeValue)+extra);
  for (let i=0;i<(node.childNodes?.length||0);i++) dump(node.childNodes[i], depth+1);
}
dump(doc);
// check text node value with CRLF
const s = plist.getElementsByTagName('string')[0];
console.log('string first child value:', JSON.stringify(s.childNodes[0].nodeValue));
console.log('has CR:', s.childNodes[0].nodeValue.includes('\r'));
