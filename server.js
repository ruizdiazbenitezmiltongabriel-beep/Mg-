const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// URL corta y estable para compartir la demo interactiva.
app.get('/demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'MG System.html'));
});

// Si la base de datos no tiene la columna 'rol', borramos el archivo viejo para recrearlo bien
const dbPath = path.join(__dirname, 'database.sqlite');

function normalizarMonto(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  return digitos ? Number(digitos) : 0;
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Error al conectar SQLite:', err);
  else console.log('Base de datos SQLite conectada correctamente.');
});

db.serialize(() => {
  // Crear tabla usuarios con rol incluido
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nombre TEXT NOT NULL,
    rol TEXT DEFAULT 'Operador'
  )`);

  // Crear tabla clientes
  db.run(`CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    servicio TEXT NOT NULL,
    monto REAL NOT NULL,
    vencimiento DATE NOT NULL,
    estado TEXT DEFAULT 'Activo'
  )`);

  // Crear tabla pagos
  db.run(`CREATE TABLE IF NOT EXISTS pagos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER,
    monto REAL NOT NULL,
    metodo TEXT NOT NULL,
    fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(cliente_id) REFERENCES clientes(id)
  )`);

  // Crear tabla ajustes
  db.run(`CREATE TABLE IF NOT EXISTS ajustes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa TEXT NOT NULL,
    moneda TEXT NOT NULL,
    dias_aviso INTEGER NOT NULL
  )`);

  // Insertar usuario Admin inicial si no existe
  db.get("SELECT COUNT(*) as count FROM usuarios", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO usuarios (usuario, password, nombre, rol) VALUES (?, ?, ?, ?)", 
        ["admin", "1234", "Administrador Principal", "Administrador"]
      );
    }
  });

  // Insertar clientes de prueba si la tabla está vacía
  db.get("SELECT COUNT(*) as count FROM clientes", (err, row) => {
    if (row && row.count === 0) {
      const stmt = db.prepare("INSERT INTO clientes (nombre, servicio, monto, vencimiento, estado) VALUES (?, ?, ?, ?, ?)");
      stmt.run("Seguro Autina", "Seguro Auto", 150000, "2026-09-28", "Activo");
      stmt.run("Seguro Macto", "Plan Vida", 100000, "2026-09-29", "Activo");
      stmt.run("María González", "Hogar Premium", 80000, "2026-08-10", "Vencido");
      stmt.finalize();
    }
  });

  // Insertar ajustes iniciales si no existen
  db.get("SELECT COUNT(*) as count FROM ajustes", (err, row) => {
    if (row && row.count === 0) {
      db.run("INSERT INTO ajustes (empresa, moneda, dias_aviso) VALUES (?, ?, ?)", ["MGSystem Pro", "Gs.", 5]);
    }
  });
});

// --- RUTAS API ---

// Login
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  db.get("SELECT * FROM usuarios WHERE usuario = ? AND password = ?", [usuario, password], (err, row) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    if (!row) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    res.json({ id: row.id, usuario: row.usuario, nombre: row.nombre, rol: row.rol || 'Operador' });
  });
});

// Registro de usuarios con Rol
app.post('/api/registro-usuario', (req, res) => {
  const { usuario, password, nombre, rol } = req.body;
  if (!usuario || !password || !nombre) {
    return res.status(400).json({ error: "Todos los campos son obligatorios" });
  }

  const userRol = rol || 'Operador';
  db.run("INSERT INTO usuarios (usuario, password, nombre, rol) VALUES (?, ?, ?, ?)", 
    [usuario, password, nombre, userRol], 
    function (err) {
      if (err) {
        if (err.message && err.message.includes("UNIQUE")) {
          return res.status(400).json({ error: "El nombre de usuario ya existe" });
        }
        return res.status(500).json({ error: err.message });
      }
      res.json({ id: this.lastID, message: "Usuario registrado con éxito" });
    }
  );
});

// Dashboard datos
app.get('/api/dashboard', (req, res) => {
  db.all("SELECT * FROM clientes", [], (err, clientes) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.all("SELECT SUM(monto) as total_pagos FROM pagos", [], (err, pagos) => {
      const totalClientes = clientes ? clientes.length : 0;
      const vencidos = clientes ? clientes.filter(c => new Date(c.vencimiento) < new Date()).length : 0;
      const facturacion = (pagos && pagos[0] && pagos[0].total_pagos) ? pagos[0].total_pagos : 330000;

      res.json({ totalClientes, vencidos, facturacion, clientes: clientes || [] });
    });
  });
});

// Lista de clientes
app.get('/api/clientes', (req, res) => {
  db.all("SELECT * FROM clientes ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Guardar nuevo cliente
app.post('/api/clientes', (req, res) => {
  const { nombre, servicio, monto, vencimiento } = req.body;
  const montoNormalizado = normalizarMonto(monto);
  if (!nombre || !servicio || montoNormalizado <= 0 || !vencimiento) {
    return res.status(400).json({ error: "Todos los campos son requeridos." });
  }
  db.run("INSERT INTO clientes (nombre, servicio, monto, vencimiento) VALUES (?, ?, ?, ?)",
    [nombre, servicio, montoNormalizado, vencimiento],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, message: "Cliente registrado con éxito" });
    }
  );
});

// Registrar cobro/pago
app.post('/api/pagos', (req, res) => {
  const { cliente_id, monto, metodo } = req.body;
  const montoNormalizado = normalizarMonto(monto);
  if (!cliente_id || montoNormalizado <= 0 || !metodo) {
    return res.status(400).json({ error: "Todos los datos de pago son obligatorios." });
  }
  
  db.run("INSERT INTO pagos (cliente_id, monto, metodo) VALUES (?, ?, ?)",
    [cliente_id, montoNormalizado, metodo],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const nuevaFecha = new Date();
      nuevaFecha.setDate(nuevaFecha.getDate() + 30);
      const fechaFormateada = nuevaFecha.toISOString().split('T')[0];

      db.run("UPDATE clientes SET vencimiento = ?, estado = 'Activo' WHERE id = ?", [fechaFormateada, cliente_id]);

      res.json({ id: this.lastID, message: "Pago procesado con éxito" });
    }
  );
});

// Historial de pagos
app.get('/api/pagos', (req, res) => {
  const query = `
    SELECT pagos.id, clientes.nombre, pagos.monto, pagos.metodo, pagos.fecha 
    FROM pagos 
    JOIN clientes ON pagos.cliente_id = clientes.id 
    ORDER BY pagos.id DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Lista de usuarios (para módulo administrativo)
app.get('/api/usuarios', (req, res) => {
  db.all("SELECT id, usuario, nombre, rol FROM usuarios ORDER BY id ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// Informes generales
app.get('/api/informes', (req, res) => {
  db.all("SELECT * FROM clientes", [], (err, clientes) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT * FROM pagos", [], (err, pagos) => {
      if (err) return res.status(500).json({ error: err.message });

      const listClientes = clientes || [];
      const listPagos = pagos || [];

      const totalCobrado = listPagos.reduce((sum, p) => sum + p.monto, 0);
      const totalClientes = listClientes.length;
      const activos = listClientes.filter(c => new Date(c.vencimiento) >= new Date()).length;
      const vencidos = totalClientes - activos;

      res.json({ totalCobrado, totalClientes, activos, vencidos, pagosCount: listPagos.length });
    });
  });
});

// Obtener Ajustes
app.get('/api/ajustes', (req, res) => {
  db.get("SELECT * FROM ajustes LIMIT 1", [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || { empresa: 'MGSystem Pro', moneda: 'Gs.', dias_aviso: 5 });
  });
});

// Guardar Ajustes
app.post('/api/ajustes', (req, res) => {
  const { empresa, moneda, dias_aviso } = req.body;
  db.run("UPDATE ajustes SET empresa = ?, moneda = ?, dias_aviso = ? WHERE id = 1", [empresa, moneda, dias_aviso], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Ajustes guardados correctamente" });
  });
});

app.listen(PORT, () => {
  console.log(`Servidor MGSystem activo en: http://localhost:${PORT}`);
});