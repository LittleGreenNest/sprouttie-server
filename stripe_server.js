// /server/package.json
{
  "name": "sprouttie-server",
  "version": "1.0.0",
  "description": "Express server for Sprouttie subscription payments",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "nodemon index.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.0.3",
    "express": "^4.18.2",
    "stripe": "^12.6.0"
  },
  "devDependencies": {
    "nodemon": "^2.0.22"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": [],
  "license": "ISC"
}
