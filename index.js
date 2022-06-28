import { TelegramClient } from "telegram";
import { StringSession  } from "telegram/sessions";
import input from "input";
import axios from "axios";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import fs from "fs";
import express from "express";

const app = express();
const port = 3000;

app.get('/', (req, res) => res.send('Telegram APP'));
app.listen(port, () => console.log(`keepalive - express started on port ${port}`));

dotenv.config();

const apiId = Number(process.env.TELEGRAM_APP_ID);
const apiHash =  process.env.TELEGRAM_HASH;
const yupSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
const apiEndpoint = process.env.API_ENDPOINT;

const channels = ['me', 'thedailyape']

const getUrls = (text) => {
  const regex = /\n(https?:\/\/[^\s]+)\n/g;
  const urls = [];
  let match;
  while (match = regex.exec(text)) {
    urls.push(match[1]);
  }
  return urls;
}

const getLastIndex = async (db, channel) => {
  const [rows] = await db.query(`SELECT last_message_id, no_message_parsed FROM channels WHERE channel = '${channel}' LIMIT 1`)
  if(!rows.length) {
    throw new Error("Channel not found");
  }
  return rows[0]
}

const updateLastIndex = async (db, channel, index, noMsgParsed) => {
  await db.query(`UPDATE channels SET last_message_id = ${index}, no_message_parsed = ${noMsgParsed} WHERE channel = '${channel}'`);
}

const postToYup = async (url) => {
  const payload = {
    url,
    tag: 'thedailyape',
    secret: yupSecret
  }
  let response
  try {
    response = await axios.post(apiEndpoint, payload);
  } catch(e) {
    console.log(e);
  }
  return response ? response.data : null;
}

const insertInPersonalFeed = async (db, client, msg) => {
  const hasMedia = 'media' in msg;
  const date = new Date(msg.date * 1000).toISOString().slice(0, 19).replace('T', ' ');
  let base64 = ''
  if(hasMedia) {
    base64 = (await client.downloadMedia(msg.media, {
      thumb: 1
    })).toString('base64');
  }
  const query = `INSERT INTO personal_feed (
    url,
    saved_on,
    media_preview,
    msg_id
    )
    VALUES (
      '${msg.message}',
      '${date}',
      '${base64}',
      '${msg.id}'
    )`;
    await db.query(query);
}

const getTelegramSession = async (db) => {
  const [rows] = await db.query(`SELECT * FROM telegram WHERE name = 'session'`);
  if(!rows.length) {
    throw new Error("Session not found");
  }
  return rows[0];
}

const saveTelegramSession = async (db, session) => {
   try {
    await getTelegramSession(db)
    await db.query(`UPDATE telegram SET value = '${session}' WHERE name = 'session'`);
   } catch(e) {
    await db.query(`INSERT INTO telegram (name, value) VALUES ('session', '${session}')`);
   }
  }

const parsePersonalFeed = async (client, db) => {
  const channel = await getLastIndex(db, channels[0]);
  let lastId = channel.last_message_id;
  let noMsgParsed = channel.no_message_parsed;
  const msgs = await client.getMessages(channels[0], { minId: 0, limit: 10, reverse: true, offsetId: lastId });
  for(let msg of msgs) {
    await insertInPersonalFeed(db, client, msg);
  }
  lastId = msgs.slice(-1)[0].id;
  const msgLastId = msgs.slice(-1)[0].id;
  if(msgLastId > lastId) {
    lastId = msgLastId;
  }
  noMsgParsed += msgs.length;
  await updateLastIndex(db, channels[0], lastId, noMsgParsed );
  if(!msgs.length) {
    await new Promise(resolve => setTimeout(resolve, 6e5));
  }
  await new Promise(resolve => setTimeout(resolve, 3e3)); 
}

const parseYupFeed = async (client, db) => {
  const channel = await getLastIndex(db, channels[1]);
  const minStartId = 1350;
  let lastId = channel.last_message_id;
  if(lastId < minStartId) {
    lastId = minStartId;
  }
  let noMsgParsed = channel.no_message_parsed;
  const msgs = await client.getMessages(channels[1], { minId: 0, limit: 10, reverse: true, offsetId: lastId });
  for(let msg of msgs) {
    const urls = getUrls(msg.message);
    for(let url of urls) {
      try {
      const yupResponse = await postToYup(url);
      console.log("Inserted Url: ", url);
      await new Promise(resolve => setTimeout(resolve, 2e3)); 
      } catch(e) {
        console.log("API Down", e);
        await new Promise(resolve => setTimeout(resolve, 6e5));
        return
      }
    }
    const msgLastId = msg.id;
    noMsgParsed += 1;
    if(msgLastId > lastId) {
      lastId = msgLastId;
    }
    await updateLastIndex(db, channels[1], lastId, noMsgParsed );
  }
  if(!msgs.length) {
    await new Promise(resolve => setTimeout(resolve, 6e5));
  }
  await new Promise(resolve => setTimeout(resolve, 3e3)); 
}

;(async () => {
  const db = await mysql.createConnection(process.env.DATABASE_URL);
  let sessionStr = ''
  try {
    const session = await getTelegramSession(db);
    sessionStr = session.value;
  } catch(e) {
  // do nothing
  }
  const stringSession = new StringSession(sessionStr);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.start({
    phoneNumber: async () => await input.text("Please enter your number: "),
    password: async () => await input.text("Please enter your password: "),
    phoneCode: async () =>
      await input.text("Please enter the code you received: "),
    onError: (err) => console.log(err),
  });
  console.log("You should now be connected.");
  await saveTelegramSession(db, client.session.save());
  
  for(;;) {
     try {
      await Promise.all([parseYupFeed(client, db)], parsePersonalFeed(client, db)); 
      await new Promise(resolve => setTimeout(resolve, 3e5));
     } catch(e) {
        console.log("Error", e)
      }
  }
  
})();