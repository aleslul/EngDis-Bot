import axios from "axios";
import { config } from "../config/env.config.js";

export class AiService {
    async getAnswer(pregunta, opciones, context = "") {
        const preguntaLimpia = pregunta.replace(/<[^>]*>?/gm, '').trim() || "Task context.";

        let promptUSS = `You are an expert English teacher solving a multiple choice question for an English Exam.\n`;
        if (context) promptUSS += `\n=== CONTEXT / THEORY / TRANSCRIPT ===\n"${context}"\n=====================================\n`;
        
        promptUSS += `\nQuestion: "${preguntaLimpia}"\n\nOptions:\n`;
        promptUSS += opciones.map(o => `- ID: ${o.id}, Text: ${o.text}`).join('\n');
        promptUSS += `\n\nIMPORTANT: Respond ONLY with the ID of the correct answer. No explanations.`;

        try {
        // Endpoint oficial de la API de Gemini
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.geminiApiKey}`;

        const res = await axios.post(url, {
            contents: [{ parts: [{ text: promptUSS }] }],
            generationConfig: {
            temperature: 0.1 // Temperatura baja para respuestas exactas
            }
        }, {
            headers: {
            'Content-Type': 'application/json'
            }
        });

        // La API de Gemini devuelve el texto en esta ruta específica del JSON
        return res.data.candidates[0].content.parts[0].text.trim();
        
        } catch (error) {
        const errorReal = error.response?.data?.error?.message || error.message;
        console.log(`    [!] Error en API Gemini: ${errorReal}`);
        return null;
        }
    }
}