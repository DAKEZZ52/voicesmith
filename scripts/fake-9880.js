const http = require('http');
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ fake: true, path: req.url }));
});
srv.listen(9880, '127.0.0.1', () => console.log('fake server on 9880'));
