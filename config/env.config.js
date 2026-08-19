import 'dotenv/config';

export const config = {
    ussToken: process.env.USS_TOKEN,
    groqApiKey: process.env.GEMINI_API_KEY,
    baseUrl: "https://edwebservices.engdis.com/api/"
};