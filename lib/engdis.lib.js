import axios from "axios";

export default class engdis {
  constructor(baseURL = "https://edwebservices.engdis.com/api/", authorization = "") {
    axios.defaults.baseURL = baseURL;
    
    axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    axios.defaults.headers.common['Accept'] = 'application/json, text/plain, */*';
    axios.defaults.headers.common['Origin'] = 'https://ed.engdis.com';
    axios.defaults.headers.common['Referer'] = 'https://ed.engdis.com/';
    
    if (authorization) {
      axios.defaults.headers.authorization = `Bearer ${authorization.trim()}`;
    }
  }

// ==========================================
  //      EXTRACCIÓN DE CONTEXTO (BASIC 3)
  // ==========================================
  async getBasicContext(code) {
    // Añadimos TODAS las rutas posibles (Grammar, Reading, Listening y Vocabulary)
    const bases = [
      `https://static.engdis.com/edprod01/edprod/Runtime/Content/Grammar/${code}/${code}.js`,
      `https://static.engdis.com/edprod01/edprod/Runtime/Content/Reading/${code}/${code}.js`,
      `https://static.engdis.com/edprod01/edprod/Runtime/Content/Listening/${code}/${code}.js`,
      // Rutas de vocabulario detectadas en la consola de red
      `https://static.engdis.com/edprod01/edprod/Runtime/Content/Vocabulary/${code}/${code}e.xml`,
      `https://static.engdis.com/edprod01/edprod/Runtime/Content/Vocabulary/${code}/${code}.xml`
    ];

    for (const url of bases) {
      try {
        const res = await axios.get(url);
        let plainText = "";

        // ----------------------------------------------------
        // CASO 1: MODO XML (Para Lecciones de Vocabulario)
        // ----------------------------------------------------
        if (url.endsWith('.xml') || res.data.includes('<?xml')) {
          const words = res.data.match(/<Word\b[^>]*>([\s\S]*?)<\/Word>/g);
          if (words) {
            plainText += "=== VOCABULARY DICTIONARY ===\n";
            words.forEach(w => {
              // Extraemos el contenido saltando el CDATA
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

        // ----------------------------------------------------
        // CASO 2: MODO JS (Red de Arrastre Universal)
        // ----------------------------------------------------
        // Atrapa strExplanation, strExpl, strText, strArticle, etc.
        const matches = res.data.matchAll(/var\s+str[a-zA-Z0-9_]+\s*=\s*(\{.*?\});/g);
        let foundJsContent = false;
        
        for (const match of matches) {
          try {
            const parsed = JSON.parse(match[1]);
            // Buscamos cualquier llave que la plataforma use para guardar texto
            const textContent = parsed.text || parsed.textExp || parsed.txt || parsed.Article || parsed.Story || "";
            
            if (textContent) {
              // Limpiamos el HTML
              plainText += textContent.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim() + "\n\n";
              foundJsContent = true;
            }
          } catch(e) { 
            // Si un bloque no es JSON válido, lo ignoramos y seguimos buscando
          } 
        }

        // Si encontró texto en este JS, lo retorna y corta el bucle
        if (foundJsContent && plainText.trim()) {
          return plainText.trim();
        }

      } catch (e) {
        // Si da 404 (No existe el archivo en esa ruta), probamos la siguiente
        continue; 
      }
    }
    return "";
  }

  // ==========================================
  //      EXTRACCIÓN DE TRANSCRIPCIONES (TOEIC)
  // ==========================================
  async getTranscript(code) {
    // Al reutilizar getBasicContext, el TOEIC se vuelve a prueba de balas y
    // adquiere la habilidad de resolver vocabularios y leer artículos automáticamente.
    return await this.getBasicContext(code); 
  }

  // ==========================================
  //      INTELIGENCIA ARTIFICIAL (GROQ)
  // ==========================================
  async consultarIA(pregunta, opciones, transcript = "") {
    const GROQ_API_KEY = process.env.GROQ_API_KEY; 
    const preguntaLimpia = pregunta.replace(/<[^>]*>?/gm, '').trim() || "Task context.";// TODO: CAMBIAR

    // Hacemos el prompt más neutral para que sirva tanto para TOEIC como para Basic 3
    let promptUSS = `You are an expert English teacher solving a multiple choice question for an English Exam.\n`; //TODO: CAMBIAR
    
    if (transcript) {
      promptUSS += `\n=== CONTEXT / THEORY / TRANSCRIPT ===\n"${transcript}"\n=====================================\n`;
    }

    promptUSS += `\nQuestion: "${preguntaLimpia}"\n\nOptions:\n`;
    promptUSS += opciones.map(o => `- ID: ${o.id}, Text: ${o.text}`).join('\n');
    promptUSS += `\n\nIMPORTANT: Respond ONLY with the ID of the correct answer. No explanations.`;

    try {
      const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: promptUSS }],
        temperature: 0.1
      }, {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      return res.data.choices[0].message.content.trim();
    } catch (error) {
      const errorReal = error.response?.data?.error?.message || error.message;
      console.log(`    [!] Error en API Groq: ${errorReal}`);
      return null;
    }
  }

// ==========================================
  //         GESTIÓN DE TESTS Y EXÁMENES
  // ==========================================
  async getTestItem(code, nodeId, parentId, partCounter = null) {
    const ids = [nodeId, parentId];
    let suffixes = ["t001", "t01", "t0", ""];

    // Si sabemos qué número de parte es, inyectamos los nuevos patrones detectados
    if (partCounter) {
      suffixes = [
        `t10${partCounter}`, // Ej: t101, t102 (Las nuevas revistas Magazine)
        `t0${partCounter}`,  // Ej: t01, t02 (TOEIC y normales divididos)
        `t00${partCounter}`, // Ej: t001, t002
        ...suffixes
      ];
    }

    for (const id of ids) {
      for (const sfx of suffixes) {
        try {
          const url = `practiceManager/GetItem/${id}/${code}${sfx}/25/0/2/`;
          const res = await axios.get(url);
          if (res.data && (res.data.i || res.data.questions)) {
            return { isSuccess: true, data: res.data };
          }
        } catch (e) {
          continue; 
        }
      }
    }
    return { isSuccess: false };
  }
  
  async SaveUserTestV1(nodeId, ParentNodeId, body) {
    try {
      const { data } = await axios.post(`/UserTestV1/SaveUserTest/${ParentNodeId}/${nodeId}/true`, { a: body });
      return { isSuccess: true, data };
    } catch (e) {
      return { isSuccess: false };
    }
  }

  // ==========================================
  //          PROGRESO Y NAVEGACIÓN
  // ==========================================
  async getSpecificCourseProgress(courseId) {
    try {
      const { data } = await axios.get(`CourseTree/GetCourseProgress/${courseId}`);
      return { isSuccess: true, data: data.CourseProgressTree.Children };
    } catch (err) {
      return { isSuccess: false, data: err.message };
    }
  }

  async getGetDefaultCourseProgress() {
    try {
      const { data } = await axios.get("CourseTree/GetDefaultCourseProgress");
      return { isSuccess: true, data: data.CourseProgressTree.Children };
    } catch (err) {
      return { isSuccess: false, data: "Error de conexión" };
    }
  }

  async getCourseTree(NodeId, ParentNodeId, NodeType = 2) {
    try {
      const { data } = await axios.post(`CourseTree/GetUserNodeProgress/${ParentNodeId}`, [
        { ParticleId: NodeId, NodeType, LockedNodes: null, particleHasProgress: true, lowestNodeType: 5 }
      ]);
      return { isSuccess: true, data: data[0].Children };
    } catch (err) {
      return { isSuccess: false };
    }
  }

  async setSucessTask(CourseId, ItemId) {
    try {
      const response = await axios.post("Progress/SetProgressPerTask", { CourseId, ItemId });
      return { isSuccess: true, data: response.data };
    } catch (err) {
      return { isSuccess: false };
    }
  }

  async getProgress() {
    try {
      const { data } = await axios.get('CourseTree/GetDefaultCourseProgress');
      let value = Math.round(data["CourseProgressTree"]["Progress"] * 100);
      return [value, data["CourseProgressTree"]["Grade"]];
    } catch (err) {
      return [0, 0];
    }
  }
}