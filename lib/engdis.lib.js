import axios from "axios";

export default class engdis {
  constructor(baseURL = "https://edwebservices.engdis.com/api/", authorization = "") {
    axios.defaults.baseURL = baseURL;
    axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    
    if (authorization) {
      axios.defaults.headers.authorization = `Bearer ${authorization}`;
    }
  }

  // ==========================================
  //      INTELIGENCIA ARTIFICIAL (GROQ)
  // ==========================================
  async consultarIA(pregunta, opciones) {
    const GROQ_API_KEY = process.env.GROQ_API_KEY; 
    const preguntaLimpia = pregunta.replace(/<[^>]*>?/gm, '').trim() || "Audio/Video task context.";

    const promptUSS = `
      You are an English teacher. Solve this multiple choice question.
      Context: English Discoveries Exam.
      Question: "${preguntaLimpia}"
      
      Options:
      ${opciones.map(o => `- ID: ${o.id}, Text: ${o.text}`).join('\n')}
      
      IMPORTANT: Respond ONLY with the ID of the correct answer. No explanations.
    `;

    try {
      const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
        model: "llama3-8b-8192",
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
      console.log("[!] Error en API Groq:", error.message);
      return null;
    }
  }

  // ==========================================
  //         GESTIÓN DE TESTS Y EXÁMENES
  // ==========================================
  async getTestItem(code, nodeId, parentId) {
    // Probamos diferentes combinaciones de IDs y sufijos para evitar el 404/500
    const ids = [nodeId, parentId];
    const suffixes = ["t001", "t01", "t0", ""];

    for (const id of ids) {
      for (const sfx of suffixes) {
        try {
          const url = `practiceManager/GetItem/${id}/${code}${sfx}/25/0/2/`;
          console.log(`    [DEBUG] Intentando ruta: ${url}`);
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
      console.log("[!] Error al enviar test:", e.response?.data || "Error de red");
      return { isSuccess: false };
    }
  }

  // ==========================================
  //          PROGRESO Y NAVEGACIÓN
  // ==========================================
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

  // ==========================================
  //              AUTENTICACIÓN
  // ==========================================
  async Login(username, password, InstitutionId = "5232957") {
    try {
      const { data } = await axios.post("Auth/ForceLogin", {
        CommunityVersion: "109", InstitutionId, Password: password, UserName: username
      });
      return data;
    } catch (e) {
      return { isSuccess: false };
    }
  }

  async Logout() {
    try {
      const { data } = await axios.get("Auth/Logout");
      return data;
    } catch (e) {
      return { isSuccess: false };
    }
  }
}