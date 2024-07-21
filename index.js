const axios = require("axios");
const OpenAI = require("openai");
const aws = require("aws-sdk");

// Get token from AWS Secrets Manager
const secretName = "will-it-rain-2";
const region = "eu-north-1";

const client = new aws.SecretsManager({
  region: region,
});

const db = new aws.DynamoDB.DocumentClient({
  region: region,
});

const dev = process.env.DEV === "true";

exports.handler = async (event) => {
  // Sends webhook to Discord
  // Read secret.WEBHOOK_DEV/WEBHOOK_PROD from AWS Secrets Manager
  const webhookSecretName = dev ? "WEBHOOK_DEV" : "WEBHOOK_PROD";
  const data = await client.getSecretValue({ SecretId: secretName }).promise();

  const url = JSON.parse(data.SecretString)[webhookSecretName];

  let weatherArray = await getWeather();

  let formattedWeather = "";

  for (let i = 0; i < 24; i++) {
    formattedWeather += `${IsoToSwe(weatherArray[i].date)} temp: ${
      weatherArray[i].temperature
    }°C, rain: ${weatherArray[i].rain} mm\n`;
  }

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
  const data = await client.getSecretValue({ SecretId: secretName }).promise();

  const token = JSON.parse(data.SecretString).OPEN_AI_KEY;

  const openai = new OpenAI({
    apiKey: token,
  });

  const promptString = `Use this data to create a short summary for the weather in swedish for Gothenburg. Include a bit of humor and emojis in the summary. Do not repeat yourself, but mention previous days if there are any. (Always mention the current day and the temperature in Celsius)`;

  const weatherDataString =
    weatherString +
    `It is currently ${new Date().toLocaleString("sv-SE", {
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
    message = {
      role: "user",
      content: rawHistory[i].data,
    };

    history.push(message);

    message = {
      role: "assistant",
      content: rawHistory[i].result,
    };

    history.push(message);
  }

  const chatCompletion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [promptMessage, ...history, weatherMessage],
  });

  console.log(chatCompletion.choices[0].message.content);

  await writeToDb(weatherDataString, chatCompletion.choices[0].message.content);

  return chatCompletion.choices[0].message.content;
}

// Test locally
if (dev) {
  (async () => {
    exports.handler();
  })();
}

const devTable = "will-it-rain-dev";
const prodTable = "will-it-rain-prod";

async function writeToDb(data, result) {
  const now = new Date().getTime();

  const params = {
    TableName: dev ? devTable : prodTable,
    Item: {
      id: now,
      data: data,
      result: result,
    },
  };

  await db.put(params).promise();
}

async function readFromDb() {
  const params = {
    TableName: dev ? devTable : prodTable,
  };

  const data = await db.scan(params).promise();

  return data.Items;
}
