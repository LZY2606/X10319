import { parse } from '../src/parse.ts';

const intro = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">`;

function t(label, body) {
  try { console.log(label, '=>', JSON.stringify(parse(intro + body + '</plist>'))); }
  catch (e) { console.log(label, '=> THROWS:', e.message.split('\n')[0]); }
}
t('PI-in-string', '<dict><key>a</key><string>x<?foo bar?>y</string></dict>');
t('PI-in-dict', '<dict><?foo bar?><key>a</key><string>x</string></dict>');
t('PI-after-value', '<dict><key>a</key><string>x</string><?foo bar?></dict>');
t('PI-in-array', '<array><?foo bar?><true/></array>');
t('unknown-entity', '<dict><key>a</key><string>&bogus;x</string></dict>');
t('known-entity', '<dict><key>a&amp;b</key><string>x&amp;y</string></dict>');
t('numeric-entity', '<dict><key>a</key><string>&#65;&#x42;</string></dict>');
t('crlf', '<dict><key>a</key><string>x\r\ny</string></dict>');
t('comment-in-string', '<dict><key>a</key><string>a<!-- c -->b</string></dict>');
t('dup-keys', '<dict><key>a</key><string>1</string><key>a</key><string>2</string></dict>');
t('unknown-tag', '<dict><key>a</key><bogus>x</bogus></dict>');
t('real-multi-text', '<dict><key>a</key><real>1<!--c-->2</real></dict>');
t('integer-multi', '<dict><key>a</key><integer>01</integer></dict>');
