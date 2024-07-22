import axios from "axios";
import OpenAI from "openai";
import {
  SecretsManager,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";

// Get token from AWS Secrets Manager
const secretName = "will-it-rain-2";
const region = "eu-north-1";

const client = new SecretsManager({
  region: region,
});

const db = new DynamoDBClient({
  region: region,
});

const dev = process.env.DEV === "true";

const command = new GetSecretValueCommand({ SecretId: secretName });

export const handler = async (event) => {
  // Sends webhook to Discord
  // Read secret.WEBHOOK_DEV/WEBHOOK_PROD from AWS Secrets Manager
  const webhookSecretName = dev ? "WEBHOOK_DEV" : "WEBHOOK_PROD";

  const data = await client.send(command);

  const url = JSON.parse(data.SecretString)[webhookSecretName];

  let weatherArray = await getWeather();

  let weatherJson = [];

  for (let i = 0; i < 24; i++) {
    weatherJson.push({
      date: IsoToSwe(weatherArray[i].date),
      temperature: weatherArray[i].temperature,
      rain: weatherArray[i].rain,
    });
  }

  let formattedWeather = JSON.stringify(weatherJson);

  console.log(weatherJson);

  const toTag = dev
    ? JSON.parse(data.SecretString).TO_TAG_DEV
    : JSON.parse(data.SecretString).TO_TAG_PROD;

  const jsonPayload = {
    content: `<${toTag}>\n` + (await openai(formattedWeather)),
  };

  await axios.post(url, jsonPayload);

  return {
    statusCode: 200,
    body: JSON.stringify("Hello from Lambda!"),
  };
};

async function getWeather() {
  const url =
    "https://opendata-download-metfcst.smhi.se/api/category/pmp3g/version/2/geotype/point/lon/11.953125/lat/57.703266/data.json";

  const response = await axios.get(url);

  let weatherArray = [];

  for (let i = 0; i < response.data.timeSeries.length; i++) {
    // Find temperature by looping through the parameters array and finding "t"
    let temperature = response.data.timeSeries[i].parameters.find(
      (parameter) => parameter.name === "t"
    );

    let rain = response.data.timeSeries[i].parameters.find(
      (parameter) => parameter.name === "pmean"
    );

    const weatherData = {
      date: response.data.timeSeries[i].validTime,
      temperature: temperature.values[0].toFixed(1),
      rain: rain.values[0],
    };

    weatherArray.push(weatherData);
  }

  return weatherArray;
}

function IsoToSwe(isoDate) {
  let timeZone = "Europe/Stockholm";
  let date = new Date(isoDate);
  return date.toLocaleString("sv-SE", { timeZone: timeZone });
}

async function openai(weatherString) {
  const data = await client.send(command);

  const token = JSON.parse(data.SecretString).OPEN_AI_KEY;

  const openai = new OpenAI({
    apiKey: token,
  });

  const promptString = `Use this data to create a short summary for the weather in swedish for Gothenburg. Include a bit of humor and emojis in the summary. Do not repeat yourself, but mention previous days if there are any. (Always mention the current day and the temperature in Celsius)`;

  const weatherDataString =
    weatherString +
    ` It is currently ${new Date().toLocaleString("sv-SE", {
      timeZone: "Europe/Stockholm",
    })}.`;

  const promptMessage = {
    role: "system",
    content: promptString,
  };

  const weatherMessage = {
    role: "system",
    content: weatherDataString,
  };

  const rawHistory = await readFromDb();

  let history = [];

  for (let i = 0; i < rawHistory.length; i++) {
    let message;

    message = {
      role: "user",
      content: rawHistory[i].data.S,
    };

    history.push(message);

    message = {
      role: "assistant",
      content: rawHistory[i].result.S,
    };

    history.push(message);
  }

  console.log(rawHistory.length);

  const chatCompletion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [promptMessage, ...history, weatherMessage],
  });

  console.log(chatCompletion.choices[0].message.content);

  await writeToDb(weatherDataString, chatCompletion.choices[0].message.content);

  return chatCompletion.choices[0].message.content;
}

const devTable = "will-it-rain-dev";
const prodTable = "will-it-rain-prod";

async function writeToDb(data, result) {
  const now = new Date().getTime().toString();

  const params = {
    TableName: dev ? devTable : prodTable,
    Item: {
      id: { N: now },
      data: { S: data },
      result: { S: result },
    },
  };

  const command = new PutItemCommand(params);

  await db.send(command);
}

async function readFromDb() {
  const params = {
    TableName: dev ? devTable : prodTable,
  };

  const command = new ScanCommand(params);

  const data = await db.send(command);

  // Sort by id
  data.Items.sort((a, b) => {
    return a.id.N - b.id.N;
  });

  // Get the last 7 items
  if (data.Items.length > 7) {
    data.Items = data.Items.slice(data.Items.length - 7);
  }

  return data.Items;
}

// Test locally
if (dev) {
  await handler();
}
