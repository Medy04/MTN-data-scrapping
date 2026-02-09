// server.js - API de Scraping MTN Côte d'Ivoire
// Version: 1.0.0
// Auteur: Solution pour n8n Cloud

const express = require('express');
const puppeteer = require('puppeteer');
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS pour permettre les requêtes depuis n8n
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Fonction de logging
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data || '');
}

// Configuration Puppeteer pour différents environnements
function getPuppeteerConfig() {
  const config = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio'
    ]
  };

  // Pour production (Railway, Render, etc.)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    config.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  return config;
}

// Fonction principale de scraping MTN
async function scrapeMTNBalance(phoneNumber, options = {}) {
  const {
    timeout = 30000,
    waitAfterClick = 3000,
    retries = 2
  } = options;

  let browser;
  let attempt = 0;

  while (attempt < retries) {
    try {
      attempt++;
      log(`Tentative ${attempt}/${retries} pour le numéro: ${phoneNumber}`);

      // Lancer le navigateur
      browser = await puppeteer.launch(getPuppeteerConfig());
      const page = await browser.newPage();

      // Configuration de la page
      await page.setViewport({ width: 1280, height: 800 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Intercepter les requêtes pour optimiser
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        // Bloquer les ressources inutiles pour accélérer
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });

      log('Navigation vers moninternet.mtn.ci...');
      
      // Navigation avec gestion d'erreur
      try {
        await page.goto('http://moninternet.mtn.ci/', {
          waitUntil: 'networkidle2',
          timeout: timeout
        });
      } catch (navError) {
        log('Erreur de navigation, tentative avec domReady...', navError.message);
        await page.goto('http://moninternet.mtn.ci/', {
          waitUntil: 'domcontentloaded',
          timeout: timeout
        });
      }

      log('Page chargée, recherche du popup...');

      // Attendre que le popup avec le champ de numéro apparaisse
      // Essayer plusieurs sélecteurs possibles
      const possibleSelectors = [
        'input[type="tel"]',
        'input[name*="phone"]',
        'input[name*="numero"]',
        'input[name*="msisdn"]',
        'input[placeholder*="numéro"]',
        'input[placeholder*="phone"]',
        'input[id*="phone"]',
        'input[id*="numero"]'
      ];

      let inputElement = null;
      let usedSelector = null;

      for (const selector of possibleSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          inputElement = await page.$(selector);
          if (inputElement) {
            usedSelector = selector;
            log(`Champ trouvé avec le sélecteur: ${selector}`);
            break;
          }
        } catch (e) {
          // Continue vers le prochain sélecteur
        }
      }

      if (!inputElement) {
        throw new Error('Champ de numéro de téléphone introuvable sur la page');
      }

      // Nettoyer le champ et saisir le numéro
      await page.click(usedSelector, { clickCount: 3 }); // Sélectionner tout
      await page.type(usedSelector, phoneNumber, { delay: 100 });
      log(`Numéro saisi: ${phoneNumber}`);

      // Attendre un peu pour que le formulaire soit prêt
      await page.waitForTimeout(500);

      // Trouver et cliquer sur le bouton de validation
      const possibleButtonSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button.btn-primary',
        'button.submit-btn',
        'button[class*="submit"]',
        'button[class*="validate"]',
        'button[class*="confirm"]'
      ];

      let buttonClicked = false;

      for (const selector of possibleButtonSelectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            const isVisible = await page.evaluate(el => {
              return el && el.offsetParent !== null;
            }, button);

            if (isVisible) {
              await button.click();
              log(`Bouton cliqué avec le sélecteur: ${selector}`);
              buttonClicked = true;
              break;
            }
          }
        } catch (e) {
          // Continue vers le prochain sélecteur
        }
      }

      // Si aucun bouton trouvé, essayer de soumettre le formulaire
      if (!buttonClicked) {
        log('Aucun bouton trouvé, tentative de soumission du formulaire...');
        await page.evaluate((sel) => {
          const input = document.querySelector(sel);
          if (input && input.form) {
            input.form.submit();
          }
        }, usedSelector);
      }

      // Attendre la navigation ou le chargement du contenu
      try {
        await page.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 15000
        });
        log('Navigation réussie vers la page de détails');
      } catch (navError) {
        log('Pas de navigation détectée, attente du chargement dynamique...');
        await page.waitForTimeout(waitAfterClick);
      }

      // Attendre que les informations de consommation soient chargées
      await page.waitForTimeout(2000);

      log('Extraction du solde data...');

      // Extraire le solde data avec plusieurs stratégies
      const result = await page.evaluate(() => {
        // Stratégie 1: Recherche par regex dans tout le texte
        const regex = /Volume\s+internet\s+disponible\s*:?\s*([0-9]+[,\.]?[0-9]*)\s*Mo/i;
        const bodyText = document.body.innerText;
        let match = bodyText.match(regex);

        if (match && match[1]) {
          const value = match[1].replace(',', '.');
          return {
            solde_data: `${value}Mo`,
            raw_value: parseFloat(value),
            unit: 'Mo',
            found: true,
            method: 'regex_full_text'
          };
        }

        // Stratégie 2: Recherche dans les éléments spécifiques
        const elements = document.querySelectorAll('div, p, span, td, li');
        for (const element of elements) {
          const text = element.textContent;
          match = text.match(regex);
          if (match && match[1]) {
            const value = match[1].replace(',', '.');
            return {
              solde_data: `${value}Mo`,
              raw_value: parseFloat(value),
              unit: 'Mo',
              found: true,
              method: 'regex_element'
            };
          }
        }

        // Stratégie 3: Recherche par classe ou ID spécifique
        const dataElements = document.querySelectorAll('[class*="data"], [class*="balance"], [id*="data"], [id*="balance"]');
        for (const element of dataElements) {
          const text = element.textContent;
          const numberMatch = text.match(/([0-9]+[,\.]?[0-9]*)\s*Mo/i);
          if (numberMatch && numberMatch[1]) {
            const value = numberMatch[1].replace(',', '.');
            return {
              solde_data: `${value}Mo`,
              raw_value: parseFloat(value),
              unit: 'Mo',
              found: true,
              method: 'class_id_search'
            };
          }
        }

        return {
          solde_data: null,
          raw_value: 0,
          unit: 'Mo',
          found: false,
          page_content: bodyText.substring(0, 1000),
          method: 'none'
        };
      });

      // Prendre une capture d'écran pour debug (en base64)
      const screenshot = await page.screenshot({
        encoding: 'base64',
        fullPage: false
      });

      await browser.close();

      if (!result.found) {
        log('Solde data non trouvé', {
          page_preview: result.page_content
        });
        
        return {
          success: false,
          error: 'Solde data non trouvé sur la page',
          debug: {
            page_content_preview: result.page_content,
            screenshot: screenshot
          },
          phone_number: phoneNumber,
          timestamp: new Date().toISOString()
        };
      }

      log('Scraping réussi!', {
        solde: result.solde_data,
        method: result.method
      });

      return {
        success: true,
        phone_number: phoneNumber,
        solde_data: result.solde_data,
        raw_value: result.raw_value,
        unit: result.unit,
        extraction_method: result.method,
        timestamp: new Date().toISOString(),
        screenshot: screenshot // Pour debug si besoin
      };

    } catch (error) {
      log(`Erreur lors de la tentative ${attempt}`, error.message);
      
      if (browser) {
        await browser.close();
      }

      // Si c'est la dernière tentative, retourner l'erreur
      if (attempt >= retries) {
        return {
          success: false,
          error: error.message,
          stack: error.stack,
          phone_number: phoneNumber,
          timestamp: new Date().toISOString()
        };
      }

      // Attendre avant de réessayer
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Route principale de scraping
app.post('/scrape-mtn', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { phone_number } = req.body;

    // Validation du numéro
    if (!phone_number) {
      return res.status(400).json({
        success: false,
        error: 'Le paramètre "phone_number" est requis'
      });
    }

    // Validation du format (basique)
    const cleanNumber = phone_number.toString().replace(/\s/g, '');
    if (!/^[0-9]{8,15}$/.test(cleanNumber)) {
      return res.status(400).json({
        success: false,
        error: 'Format de numéro invalide. Utilisez 8 à 15 chiffres.'
      });
    }

    log(`Démarrage du scraping pour: ${cleanNumber}`);

    // Options de scraping (peuvent être passées dans le body)
    const options = {
      timeout: req.body.timeout || 30000,
      waitAfterClick: req.body.waitAfterClick || 3000,
      retries: req.body.retries || 2
    };

    // Exécuter le scraping
    const result = await scrapeMTNBalance(cleanNumber, options);

    // Ajouter le temps d'exécution
    result.execution_time_ms = Date.now() - startTime;

    // Retourner le résultat
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }

  } catch (error) {
    log('Erreur serveur', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur',
      message: error.message,
      execution_time_ms: Date.now() - startTime
    });
  }
});

// Route de santé
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MTN CI Scraper API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Route de test
app.get('/', (req, res) => {
  res.json({
    message: 'API de scraping MTN Côte d\'Ivoire',
    version: '1.0.0',
    endpoints: {
      scrape: 'POST /scrape-mtn',
      health: 'GET /health'
    },
    example: {
      url: '/scrape-mtn',
      method: 'POST',
      body: {
        phone_number: '0707070707',
        timeout: 30000,
        waitAfterClick: 3000,
        retries: 2
      }
    }
  });
});

// Gestion des erreurs 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint non trouvé',
    path: req.path
  });
});

// Démarrage du serveur
const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  log(`🚀 Serveur de scraping MTN démarré sur le port ${PORT}`);
  log(`📍 Environnement: ${process.env.NODE_ENV || 'development'}`);
  log(`🌐 URL: http://localhost:${PORT}`);
});

// Gestion de l'arrêt gracieux
process.on('SIGTERM', () => {
  log('SIGTERM reçu, arrêt du serveur...');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT reçu, arrêt du serveur...');
  process.exit(0);
});