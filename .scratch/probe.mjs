import { DOMParser } from '@xmldom/xmldom';

function show(label, xml) {
  let doc;
  try {
    doc = new DOMParser({
      onError: (level, m) => {
        console.log(label, level.toUpperCase(), String(m).split('\n')[0]);
        if (level === 'fatalError') throw new Error(String(m).split('\n')[0]);
      },
    }).parseFromString(xml, 'text/xml');
  } catch (e) { console.log(label, 'THREW', e.message.split('\n')[0]); return; }
  const walk = (n, d=0) => {
    const v = n.nodeValue === undefined ? '' : JSON.stringify(n.nodeValue);
    console.log(label, ' '.repeat(d), n.nodeType, n.nodeName, v);
    for (let i=0;i<n.childNodes?.length;i++) walk(n.childNodes[i], d+2);
  };
  walk(doc);
}

show('CRLF', '<plist version="1.0"><dict><key>a</key><string>x\r\ny</string></dict></plist>');
show('CR', '<plist version="1.0"><dict><key>a</key><string>x\ry</string></dict></plist>');
show('CDATA-CRLF', '<plist version="1.0"><dict><key>a</key><string><![CDATA[x\r\ny]]></string></dict></plist>');
show('UNKNOWN-ENT', '<plist version="1.0"><dict><key>a</key><string>&bogus;x</string></dict></plist>');
show('PI-STRING', '<plist version="1.0"><dict><key>a</key><string>x<?foo bar?>y</string></dict></plist>');
show('PI-DICT', '<plist version="1.0"><dict><?foo bar?><key>a</key><string>x</string></dict></plist>');
show('PI-PRELUDE', '<?xml version="1.0"?>\n<?foo bar?>\n<!DOCTYPE plist PUBLIC "-//a//DTD" "http://x">\n<plist version="1.0"><dict><key>a</key><string>x</string></dict></plist>\n');
show('NUMENT', '<plist version="1.0"><dict><key>a</key><string>&#65;&#x42;&amp;&quot;&apos;&lt;&gt;</string></dict></plist>');
show('SC', '<plist version="1.0"><dict><key/><string/></dict></plist>');
