// Set up test environment variables
process.env.MYSQL_HOST = 'localhost';
process.env.MYSQL_PORT = '3306';
process.env.MYSQL_DB = 'test_db';
process.env.MYSQL_USER = 'test_user';
process.env.MYSQL_PASSWORD = 'test_password';

import { QueryValidator } from '../security/query-validator.js';

describe('QueryValidator', () => {
  let validator: QueryValidator;

  beforeEach(() => {
    validator = new QueryValidator();
  });

  describe('validate', () => {
    it('should allow valid SELECT queries', () => {
      const result = validator.validate('SELECT * FROM users LIMIT 10');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject empty queries', () => {
      const result = validator.validate('');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Query must be a non-empty string');
    });

    it('should reject non-string queries', () => {
      const result = validator.validate(null as any);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Query must be a non-empty string');
    });

    it('should reject INSERT queries', () => {
      const result = validator.validate('INSERT INTO users (name) VALUES ("test")');
      expect(result.isValid).toBe(false);
      expect(result.errors.some(error => error.includes('INSERT'))).toBe(true);
    });

    it('should reject UPDATE queries', () => {
      const result = validator.validate('UPDATE users SET name = "test"');
      expect(result.isValid).toBe(false);
      expect(result.errors.some(error => error.includes('UPDATE'))).toBe(true);
    });

    it('should reject DELETE queries', () => {
      const result = validator.validate('DELETE FROM users');
      expect(result.isValid).toBe(false);
      expect(result.errors.some(error => error.includes('DELETE'))).toBe(true);
    });

    it('should reject overly long queries', () => {
      const longQuery = 'SELECT * FROM users WHERE name = "' + 'a'.repeat(20000) + '"';
      const result = validator.validate(longQuery);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(error => error.includes('maximum length'))).toBe(true);
    });

    it('should detect suspicious SQL injection patterns', () => {
      const result = validator.validate("SELECT * FROM users WHERE id = 1' OR '1'='1");
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should provide warnings for complex queries', () => {
      const complexQuery = `
        SELECT u.*, p.*, o.*
        FROM users u
        JOIN profiles p ON u.id = p.user_id
        JOIN orders o ON u.id = o.user_id
        WHERE u.status = 'active'
        GROUP BY u.id
        HAVING COUNT(o.id) > 5
        ORDER BY u.created_at DESC
      `;
      const result = validator.validate(complexQuery);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('getQueryAnalysis', () => {
    it('should analyze query structure correctly', () => {
      const analysis = validator.getQueryAnalysis('SELECT name, email FROM users WHERE active = 1');
      expect(analysis.operation).toBe('SELECT');
      expect(analysis.hasJoins).toBe(false);
      expect(analysis.hasSubqueries).toBe(false);
      expect(analysis.estimatedComplexity).toBe('low');
    });

    it('should detect JOINs', () => {
      const analysis = validator.getQueryAnalysis('SELECT * FROM users u JOIN profiles p ON u.id = p.user_id');
      expect(analysis.hasJoins).toBe(true);
      expect(analysis.estimatedComplexity).toBe('low'); // Simple JOIN has score 2, which is low complexity
    });

    it('should detect subqueries', () => {
      const analysis = validator.getQueryAnalysis('SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)');
      expect(analysis.hasSubqueries).toBe(true);
    });
  });

  describe('isOperationAllowed', () => {
    it('should allow SELECT operations', () => {
      expect(validator.isOperationAllowed('SELECT')).toBe(true);
    });

    it('should allow SHOW operations', () => {
      expect(validator.isOperationAllowed('SHOW')).toBe(true);
    });

    it('should allow DESCRIBE operations', () => {
      expect(validator.isOperationAllowed('DESCRIBE')).toBe(true);
    });

    it('should reject INSERT operations', () => {
      expect(validator.isOperationAllowed('INSERT')).toBe(false);
    });

    it('should reject UPDATE operations', () => {
      expect(validator.isOperationAllowed('UPDATE')).toBe(false);
    });

    it('should reject DELETE operations', () => {
      expect(validator.isOperationAllowed('DELETE')).toBe(false);
    });
  });
});