import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/authMiddleware.ts';
import {
  getAnalyticsSummary,
  getOrganisationAnalyticsDashboard,
} from '../services/queueEngine.ts';

export const analyticsRoutes = Router();

analyticsRoutes.get(
  '/organisation/dashboard',
  requireAuth,
  requireRole('admin', 'operator'),
  (req, res) => {
    const facilityId = (req.query.facilityId as string) || 'all';
    const rawPeriod = ((req.query.period as string) || 'daily').toLowerCase();
    const period: 'daily' | 'weekly' | 'monthly' =
      rawPeriod === 'weekly' || rawPeriod === 'monthly' ? rawPeriod : 'daily';
    const threshold = req.query.threshold ? Number(req.query.threshold) : undefined;

    const dashboard = getOrganisationAnalyticsDashboard({
      facilityId,
      period,
      surgeThreshold: threshold,
    });
    if (!dashboard) {
      res.status(404).json({ error: `Facility '${facilityId}' not found.` });
      return;
    }
    res.json(dashboard);
  }
);

analyticsRoutes.get('/:facilityId/summary', (req, res) => {
  const { facilityId } = req.params;
  const summary = getAnalyticsSummary(facilityId);
  if (!summary) {
    res.status(404).json({ error: `Facility '${facilityId}' not found.` });
    return;
  }
  res.json(summary);
});
