import { Routes } from '@angular/router';
import { PlannerPage } from './planner/planner-page';

export const routes: Routes = [
  { path: '', component: PlannerPage, title: 'SkyRoute Warsaw' },
  // Loaded on demand: the planner's bundle does not grow with the simulation view.
  { path: 'simulate', loadComponent: () => import('./sim/sim-page').then((m) => m.SimPage), title: 'Simulation · SkyRoute Warsaw' },
  { path: '**', redirectTo: '' },
];
