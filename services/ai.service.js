import axios from "axios";

export class AiService {
    constructor(geminiApiKey) {
        this.geminiApiKey = geminiApiKey;
    }

    // Resuelve TODAS las preguntas del Test en 1 sola llamada HTTP
    async getBatchAnswers(questionsBatch, context = "") {
        let promptUSS = `You are an expert English teacher solving an English exam.\n`;
        if (context) {
            promptUSS += `\n=== READING / LISTENING / GRAMMAR CONTEXT ===\n${context}\n=============================================\n`;
        }
        
        promptUSS += `\nSolve the following questions. For each item "key", choose the best option "id" from its "options" list.\n`;
        promptUSS += `Questions JSON:\n${JSON.stringify(questionsBatch)}\n\n`;
        promptUSS += `IMPORTANT: Return ONLY a valid JSON object mapping each "key" to the chosen numeric option "id". Example: {"0": 2, "1": 4}`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${this.geminiApiKey}`;

        // Hasta 3 intentos rápidos si el servidor de Gemini tiene "high demand"
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await axios.post(url, {
                    contents: [{ parts: [{ text: promptUSS }] }],
                    generationConfig: { 
                        temperature: 0.1,
                        responseMimeType: "application/json"
                    }
                }, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000 // Máximo 15s para evitar cuelgues largos
                });

                const rawText = res.data.candidates[0].content.parts[0].text.trim();
                return JSON.parse(rawText);
            } catch (error) {
                const msg = error.response?.data?.error?.message || error.message;
                console.log(`    [!] Intento IA ${attempt}/3 falló: ${msg}`);
                if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            }
        }
        return {};
    }
}