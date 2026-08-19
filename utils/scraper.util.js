import axios from "axios";

export class ScraperUtil {
    static async getContext(code) {
        const bases = [
        `https://static.engdis.com/edprod01/edprod/Runtime/Content/Grammar/${code}/${code}.js`,
        `https://static.engdis.com/edprod01/edprod/Runtime/Content/Reading/${code}/${code}.js`,
        `https://static.engdis.com/edprod01/edprod/Runtime/Content/Listening/${code}/${code}.js`,
        `https://static.engdis.com/edprod01/edprod/Runtime/Content/Vocabulary/${code}/${code}e.xml`,
        `https://static.engdis.com/edprod01/edprod/Runtime/Content/Vocabulary/${code}/${code}.xml`
        ];

        for (const url of bases) {
        try {
            const res = await axios.get(url);
            let plainText = "";

            if (url.endsWith('.xml') || res.data.includes('<?xml')) {
            const words = res.data.match(/<Word\b[^>]*>([\s\S]*?)<\/Word>/g);
            if (words) {
                plainText += "=== VOCABULARY DICTIONARY ===\n";
                words.forEach(w => {
                const defMatch = w.match(/<Definition[^>]*>(.*?)<\/Definition>/);
                const expMatch = w.match(/<Explanation[^>]*><!\[CDATA\[(.*?)\]\]><\/Explanation>/);
                const exMatch = w.match(/<Example[^>]*><!\[CDATA\[(.*?)\]\]><\/Example>/);
                const word = defMatch ? defMatch[1].replace(/<[^>]*>?/gm, '').trim() : "";
                const explanation = expMatch ? expMatch[1].replace(/<[^>]*>?/gm, '').trim() : "";
                const example = exMatch ? exMatch[1].replace(/<[^>]*>?/gm, '').trim() : "";
                if (word) plainText += `- Word: "${word}" | Meaning: ${explanation} | Example: ${example}\n`;
                });
                return plainText.trim(); 
            }
            }

            const matches = res.data.matchAll(/var\s+str[a-zA-Z0-9_]+\s*=\s*(\{.*?\});/g);
            let foundJsContent = false;
            
            for (const match of matches) {
            try {
                const parsed = JSON.parse(match[1]);
                const textContent = parsed.text || parsed.textExp || parsed.txt || parsed.Article || parsed.Story || "";
                if (textContent) {
                plainText += textContent.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim() + "\n\n";
                foundJsContent = true;
                }
            } catch(e) {} 
            }

            if (foundJsContent && plainText.trim()) return plainText.trim();
        } catch (e) { continue; }
        }
        return "";
    }

    static parseAnswerId(idCorrecto, options) {
        let finalAnswerId = options.length > 0 ? options[0].id : 0; 
        if (idCorrecto) {
        const match = idCorrecto.match(/\d+/); 
        if (match) {
            const parsedId = parseInt(match[0], 10);
            if (options.some(o => o.id === parsedId)) finalAnswerId = parsedId;
        }
        }
        return finalAnswerId;
    }
}