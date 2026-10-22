// A local SMTP server for the end-to-end tests and local development (KTD12). The
// Worker runs with OUTBOUND_MOCK_SMTP pointing here, so every SMTP connection arrives
// at this server instead of the real host. No message leaves this machine.
//
//   node e2e/smtp-mock.mjs <smtp-port> [<http-port>]
//
// TLS is simulated. The server speaks plain TCP on 127.0.0.1. It advertises STARTTLS
// and answers it with 220, and then the session goes on in plain text, as if the
// handshake had happened. The Worker's mock socket (apps/worker/src/sockets.ts) keeps
// the plain socket at `startTls()`. Real TLS and certificate checks need a real server.
//
// Any user name with any password is accepted, except the password "wrong", which gets
// a 535. A recipient that starts with "reject" gets a 550 at RCPT TO.
//
// With an HTTP port, `GET /messages` returns the accepted messages as JSON, and
// `DELETE /messages` clears them, so a test can check what the Worker sent.
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";

const smtpPort = Number(process.argv[2]);
const httpPort = Number(process.argv[3]);
if (!smtpPort) {
  console.error("Usage: node e2e/smtp-mock.mjs <smtp-port> [<http-port>]");
  process.exit(1);
}

/** Accepted messages: envelope and data, with the dot-stuffing removed. */
const messages = [];

function decodeBase64(text) {
  return Buffer.from(text.trim(), "base64").toString("utf8");
}

function session(socket) {
  let buffer = "";
  let state = "command";
  let secure = false;
  let authenticated = false;
  let envelope = null;
  let data = [];
  const send = (line) => socket.write(`${line}\r\n`);

  const checkCredentials = (password) => {
    if (password === "wrong") return send("535 5.7.8 Authentication credentials invalid");
    authenticated = true;
    send("235 2.7.0 Authentication successful");
  };

  const handle = (line) => {
    if (state === "data") {
      if (line !== ".") {
        data.push(line.startsWith(".") ? line.slice(1) : line);
        return;
      }
      state = "command";
      messages.push({ ...envelope, data: data.join("\r\n"), secure });
      envelope = null;
      send(`250 2.0.0 Ok: queued as M${messages.length}`);
      return;
    }
    if (state === "auth-plain") {
      state = "command";
      return checkCredentials(decodeBase64(line).split("\0")[2] ?? "");
    }
    if (state === "auth-login-user") {
      state = "auth-login-pass";
      return send("334 UGFzc3dvcmQ6");
    }
    if (state === "auth-login-pass") {
      state = "command";
      return checkCredentials(decodeBase64(line));
    }
    const space = line.indexOf(" ");
    const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const arg = space < 0 ? "" : line.slice(space + 1);
    switch (verb) {
      case "EHLO": {
        const lines = ["smtp-mock.test", "8BITMIME", "SIZE 10485760"];
        if (!secure) lines.push("STARTTLS");
        else lines.push("AUTH PLAIN LOGIN");
        lines.forEach((text, index) => {
          send(`250${index === lines.length - 1 ? " " : "-"}${text}`);
        });
        return;
      }
      case "HELO":
        return send("250 smtp-mock.test");
      case "STARTTLS":
        // Simulated: no handshake. The session counts as secure from here.
        secure = true;
        return send("220 2.0.0 Ready to start TLS (simulated)");
      case "AUTH": {
        const [mechanism = "", initial] = arg.split(" ");
        if (mechanism.toUpperCase() === "PLAIN") {
          if (initial) return checkCredentials(decodeBase64(initial).split("\0")[2] ?? "");
          state = "auth-plain";
          return send("334 ");
        }
        if (mechanism.toUpperCase() === "LOGIN") {
          state = "auth-login-user";
          return send("334 VXNlcm5hbWU6");
        }
        return send("504 5.5.4 Unrecognized authentication type");
      }
      case "MAIL":
        if (!authenticated) return send("530 5.7.0 Authentication required");
        envelope = { from: arg.replace(/^FROM:/i, "").replace(/[<>]/g, ""), to: [] };
        return send("250 2.1.0 Ok");
      case "RCPT": {
        if (!envelope) return send("503 5.5.1 Need MAIL first");
        const to = arg.replace(/^TO:/i, "").replace(/[<>]/g, "");
        if (to.startsWith("reject")) return send("550 5.1.1 The email account does not exist");
        envelope.to.push(to);
        return send("250 2.1.5 Ok");
      }
      case "DATA":
        if (!envelope || envelope.to.length === 0) return send("503 5.5.1 Need RCPT first");
        state = "data";
        data = [];
        return send("354 End data with <CR><LF>.<CR><LF>");
      case "RSET":
        envelope = null;
        return send("250 2.0.0 Ok");
      case "NOOP":
        return send("250 2.0.0 Ok");
      case "QUIT":
        send("221 2.0.0 Bye");
        socket.end();
        return;
      default:
        return send("500 5.5.2 Command not recognized");
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end = buffer.indexOf("\r\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      handle(line);
      end = buffer.indexOf("\r\n");
    }
  });
  socket.on("error", () => {});
  send("220 smtp-mock.test ESMTP ready (TLS is simulated)");
}

createServer(session).listen(smtpPort, "127.0.0.1", () => {
  console.log(`SMTP mock on 127.0.0.1:${smtpPort}`);
});

if (httpPort) {
  createHttpServer((req, res) => {
    if (req.url === "/messages" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(messages));
    }
    if (req.url === "/messages" && req.method === "DELETE") {
      messages.length = 0;
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  }).listen(httpPort, "127.0.0.1", () => {
    console.log(`SMTP mock messages on http://127.0.0.1:${httpPort}/messages`);
  });
}
