/**
 * The demo company's people.
 *
 * A sales demo is only as convincing as the directory behind it, so this is a
 * plausible 45-person Indian manufacturing company rather than ten rows: six
 * departments, three locations, real reporting lines, joining dates spread over
 * eight years, and salaries that sit either side of every statutory threshold
 * (ESI at 21k gross, PF at 15k basic, PT by state) so a demo can show the
 * deductions actually differing between people.
 *
 * Kept apart from seed-demo.ts because the roster is data and the seeding is
 * procedure; editing one should not risk the other.
 */

export interface Person {
  number: string
  first: string
  last: string
  email: string
  role: string
  department: string
  designation: string
  location: 'Hyderabad' | 'Pune' | 'Coimbatore'
  stateCode: 'TS' | 'MH' | 'TN'
  joinedOn: string
  /** Employee number of this person's manager; null for the two who report to nobody. */
  manager: string | null
  ctc: number
  basic: number
  hra: number
  special: number
  isManager?: boolean
}

/** Monthly gross under ESI's 21,000 ceiling means ESI applies — deliberate on the shop floor. */
export const PEOPLE: Person[] = [
  // ---- Leadership -------------------------------------------------------
  { number: 'ACM-001', first: 'Priya', last: 'Sharma', email: 'priya@acme.test', role: 'hr_admin',
    department: 'Human Resources', designation: 'Head of HR', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2018-04-02', manager: null, isManager: true,
    ctc: 2_400_000, basic: 80_000, hra: 40_000, special: 80_000 },
  { number: 'ACM-002', first: 'Anil', last: 'Verma', email: 'anil@acme.test', role: 'payroll_admin',
    department: 'Finance', designation: 'Finance Controller', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2018-07-16', manager: null, isManager: true,
    ctc: 2_100_000, basic: 70_000, hra: 35_000, special: 70_000 },

  // ---- Engineering (Hyderabad) -----------------------------------------
  { number: 'ACM-003', first: 'Arjun', last: 'Rao', email: 'arjun@acme.test', role: 'manager',
    department: 'Engineering', designation: 'Engineering Manager', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2019-01-07', manager: null, isManager: true,
    ctc: 1_800_000, basic: 60_000, hra: 30_000, special: 60_000 },
  { number: 'ACM-004', first: 'Rahul', last: 'Nair', email: 'rahul@acme.test', role: 'employee',
    department: 'Engineering', designation: 'Senior Developer', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2020-02-17', manager: 'ACM-003',
    ctc: 1_200_000, basic: 40_000, hra: 20_000, special: 40_000 },
  { number: 'ACM-005', first: 'Sneha', last: 'Iyer', email: 'sneha@acme.test', role: 'employee',
    department: 'Engineering', designation: 'Developer', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2021-06-14', manager: 'ACM-003',
    ctc: 840_000, basic: 28_000, hra: 14_000, special: 28_000 },
  { number: 'ACM-011', first: 'Karthik', last: 'Reddy', email: 'karthik@acme.test', role: 'employee',
    department: 'Engineering', designation: 'Developer', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2022-03-21', manager: 'ACM-003',
    ctc: 780_000, basic: 26_000, hra: 13_000, special: 26_000 },
  { number: 'ACM-012', first: 'Meera', last: 'Krishnan', email: 'meera@acme.test', role: 'employee',
    department: 'Engineering', designation: 'QA Engineer', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2022-08-08', manager: 'ACM-003',
    ctc: 660_000, basic: 22_000, hra: 11_000, special: 22_000 },
  { number: 'ACM-013', first: 'Faisal', last: 'Ahmed', email: 'faisal@acme.test', role: 'employee',
    department: 'Engineering', designation: 'DevOps Engineer', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2023-01-09', manager: 'ACM-003',
    ctc: 960_000, basic: 32_000, hra: 16_000, special: 32_000 },
  { number: 'ACM-014', first: 'Divya', last: 'Menon', email: 'divya@acme.test', role: 'employee',
    department: 'Engineering', designation: 'Junior Developer', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2025-07-01', manager: 'ACM-003',
    ctc: 480_000, basic: 16_000, hra: 8_000, special: 16_000 },
  { number: 'ACM-015', first: 'Sandeep', last: 'Joshi', email: 'sandeep@acme.test', role: 'employee',
    department: 'Engineering', designation: 'Design Engineer', location: 'Pune', stateCode: 'MH',
    joinedOn: '2021-11-15', manager: 'ACM-003',
    ctc: 900_000, basic: 30_000, hra: 15_000, special: 30_000 },

  // ---- Production (Coimbatore shop floor) -------------------------------
  { number: 'ACM-006', first: 'Vikram', last: 'Singh', email: 'vikram@acme.test', role: 'manager',
    department: 'Production', designation: 'Plant Manager', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2019-05-20', manager: null, isManager: true,
    ctc: 1_320_000, basic: 44_000, hra: 22_000, special: 44_000 },
  { number: 'ACM-016', first: 'Ganesh', last: 'Murugan', email: 'ganesh@acme.test', role: 'employee',
    department: 'Production', designation: 'Shift Supervisor', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2020-09-01', manager: 'ACM-006',
    ctc: 420_000, basic: 14_000, hra: 7_000, special: 14_000 },
  { number: 'ACM-017', first: 'Lakshmi', last: 'Devi', email: 'lakshmi@acme.test', role: 'employee',
    department: 'Production', designation: 'Machine Operator', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2021-02-11', manager: 'ACM-016',
    ctc: 264_000, basic: 11_000, hra: 5_500, special: 5_500 },
  { number: 'ACM-018', first: 'Murali', last: 'Selvam', email: 'murali@acme.test', role: 'employee',
    department: 'Production', designation: 'Machine Operator', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2021-04-05', manager: 'ACM-016',
    ctc: 264_000, basic: 11_000, hra: 5_500, special: 5_500 },
  { number: 'ACM-019', first: 'Suresh', last: 'Kumar', email: 'suresh@acme.test', role: 'employee',
    department: 'Production', designation: 'Machine Operator', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2022-01-17', manager: 'ACM-016',
    ctc: 252_000, basic: 10_500, hra: 5_250, special: 5_250 },
  { number: 'ACM-020', first: 'Kavitha', last: 'Raman', email: 'kavitha@acme.test', role: 'employee',
    department: 'Production', designation: 'Quality Inspector', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2022-06-06', manager: 'ACM-006',
    ctc: 336_000, basic: 14_000, hra: 7_000, special: 7_000 },
  { number: 'ACM-021', first: 'Balaji', last: 'Natarajan', email: 'balaji@acme.test', role: 'employee',
    department: 'Production', designation: 'Maintenance Technician', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2023-03-13', manager: 'ACM-016',
    ctc: 288_000, basic: 12_000, hra: 6_000, special: 6_000 },
  { number: 'ACM-022', first: 'Ramesh', last: 'Pillai', email: 'ramesh@acme.test', role: 'employee',
    department: 'Production', designation: 'Store Keeper', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2023-08-21', manager: 'ACM-006',
    ctc: 276_000, basic: 11_500, hra: 5_750, special: 5_750 },
  { number: 'ACM-023', first: 'Anitha', last: 'Subramani', email: 'anitha@acme.test', role: 'employee',
    department: 'Production', designation: 'Machine Operator', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2024-02-19', manager: 'ACM-016',
    ctc: 252_000, basic: 10_500, hra: 5_250, special: 5_250 },
  { number: 'ACM-024', first: 'Prakash', last: 'Veeraswamy', email: 'prakash@acme.test', role: 'employee',
    department: 'Production', designation: 'Shift Supervisor', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2024-07-08', manager: 'ACM-006',
    ctc: 396_000, basic: 13_200, hra: 6_600, special: 13_200 },
  { number: 'ACM-025', first: 'Jyothi', last: 'Bai', email: 'jyothi@acme.test', role: 'employee',
    department: 'Production', designation: 'Packing Assistant', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2025-01-13', manager: 'ACM-016',
    ctc: 228_000, basic: 9_500, hra: 4_750, special: 4_750 },

  // ---- Sales (Pune) -----------------------------------------------------
  { number: 'ACM-007', first: 'Neha', last: 'Kulkarni', email: 'neha@acme.test', role: 'manager',
    department: 'Sales', designation: 'Regional Sales Head', location: 'Pune', stateCode: 'MH',
    joinedOn: '2019-09-02', manager: null, isManager: true,
    ctc: 1_560_000, basic: 52_000, hra: 26_000, special: 52_000 },
  { number: 'ACM-026', first: 'Rohit', last: 'Deshmukh', email: 'rohit@acme.test', role: 'employee',
    department: 'Sales', designation: 'Area Sales Manager', location: 'Pune', stateCode: 'MH',
    joinedOn: '2020-11-23', manager: 'ACM-007',
    ctc: 840_000, basic: 28_000, hra: 14_000, special: 28_000 },
  { number: 'ACM-027', first: 'Pooja', last: 'Patil', email: 'pooja@acme.test', role: 'employee',
    department: 'Sales', designation: 'Sales Executive', location: 'Pune', stateCode: 'MH',
    joinedOn: '2022-04-11', manager: 'ACM-026',
    ctc: 480_000, basic: 16_000, hra: 8_000, special: 16_000 },
  { number: 'ACM-028', first: 'Amit', last: 'Chavan', email: 'amit@acme.test', role: 'employee',
    department: 'Sales', designation: 'Sales Executive', location: 'Pune', stateCode: 'MH',
    joinedOn: '2022-10-03', manager: 'ACM-026',
    ctc: 456_000, basic: 15_200, hra: 7_600, special: 15_200 },
  { number: 'ACM-029', first: 'Sanjana', last: 'Bhosale', email: 'sanjana@acme.test', role: 'employee',
    department: 'Sales', designation: 'Inside Sales', location: 'Pune', stateCode: 'MH',
    joinedOn: '2023-05-29', manager: 'ACM-026',
    ctc: 396_000, basic: 13_200, hra: 6_600, special: 13_200 },
  { number: 'ACM-030', first: 'Imran', last: 'Shaikh', email: 'imran@acme.test', role: 'employee',
    department: 'Sales', designation: 'Sales Executive', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2024-01-15', manager: 'ACM-007',
    ctc: 444_000, basic: 14_800, hra: 7_400, special: 14_800 },
  { number: 'ACM-031', first: 'Tanvi', last: 'Gokhale', email: 'tanvi@acme.test', role: 'employee',
    department: 'Sales', designation: 'Key Account Manager', location: 'Pune', stateCode: 'MH',
    joinedOn: '2024-09-09', manager: 'ACM-007',
    ctc: 720_000, basic: 24_000, hra: 12_000, special: 24_000 },
  { number: 'ACM-032', first: 'Vishal', last: 'More', email: 'vishal@acme.test', role: 'employee',
    department: 'Sales', designation: 'Sales Executive', location: 'Pune', stateCode: 'MH',
    joinedOn: '2026-08-03', manager: 'ACM-026',
    ctc: 420_000, basic: 14_000, hra: 7_000, special: 14_000 },

  // ---- Finance (Hyderabad) ---------------------------------------------
  { number: 'ACM-008', first: 'Deepa', last: 'Agarwal', email: 'deepa@acme.test', role: 'employee',
    department: 'Finance', designation: 'Accounts Manager', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2020-06-15', manager: 'ACM-002',
    ctc: 960_000, basic: 32_000, hra: 16_000, special: 32_000 },
  { number: 'ACM-033', first: 'Nitin', last: 'Bansal', email: 'nitin@acme.test', role: 'employee',
    department: 'Finance', designation: 'Accounts Executive', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2022-02-14', manager: 'ACM-008',
    ctc: 468_000, basic: 15_600, hra: 7_800, special: 15_600 },
  { number: 'ACM-034', first: 'Swathi', last: 'Reddy', email: 'swathi@acme.test', role: 'employee',
    department: 'Finance', designation: 'Payroll Executive', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2023-07-24', manager: 'ACM-002',
    ctc: 504_000, basic: 16_800, hra: 8_400, special: 16_800 },
  { number: 'ACM-035', first: 'Harish', last: 'Chandra', email: 'harish@acme.test', role: 'employee',
    department: 'Finance', designation: 'Accounts Assistant', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2024-11-11', manager: 'ACM-008',
    ctc: 312_000, basic: 13_000, hra: 6_500, special: 6_500 },

  // ---- Human Resources --------------------------------------------------
  { number: 'ACM-009', first: 'Ritu', last: 'Malhotra', email: 'ritu@acme.test', role: 'employee',
    department: 'Human Resources', designation: 'HR Business Partner', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2021-03-08', manager: 'ACM-001',
    ctc: 780_000, basic: 26_000, hra: 13_000, special: 26_000 },
  { number: 'ACM-036', first: 'Aditya', last: 'Saxena', email: 'aditya@acme.test', role: 'employee',
    department: 'Human Resources', designation: 'Talent Acquisition Lead', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2022-12-05', manager: 'ACM-001',
    ctc: 720_000, basic: 24_000, hra: 12_000, special: 24_000 },
  { number: 'ACM-037', first: 'Shruti', last: 'Desai', email: 'shruti@acme.test', role: 'employee',
    department: 'Human Resources', designation: 'HR Executive', location: 'Pune', stateCode: 'MH',
    joinedOn: '2024-04-01', manager: 'ACM-009',
    ctc: 432_000, basic: 14_400, hra: 7_200, special: 14_400 },
  { number: 'ACM-038', first: 'Mohan', last: 'Prasad', email: 'mohan@acme.test', role: 'employee',
    department: 'Human Resources', designation: 'Admin Officer', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2023-10-16', manager: 'ACM-001',
    ctc: 324_000, basic: 13_500, hra: 6_750, special: 6_750 },

  // ---- Supply Chain -----------------------------------------------------
  { number: 'ACM-010', first: 'Vivek', last: 'Choudhary', email: 'vivek@acme.test', role: 'manager',
    department: 'Supply Chain', designation: 'Supply Chain Manager', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2020-01-20', manager: null, isManager: true,
    ctc: 1_140_000, basic: 38_000, hra: 19_000, special: 38_000 },
  { number: 'ACM-039', first: 'Naveen', last: 'Gupta', email: 'naveen@acme.test', role: 'employee',
    department: 'Supply Chain', designation: 'Procurement Executive', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2021-08-30', manager: 'ACM-010',
    ctc: 528_000, basic: 17_600, hra: 8_800, special: 17_600 },
  { number: 'ACM-040', first: 'Rekha', last: 'Sinha', email: 'rekha@acme.test', role: 'employee',
    department: 'Supply Chain', designation: 'Logistics Coordinator', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2022-11-07', manager: 'ACM-010',
    ctc: 444_000, basic: 14_800, hra: 7_400, special: 14_800 },
  { number: 'ACM-041', first: 'Zubair', last: 'Khan', email: 'zubair@acme.test', role: 'employee',
    department: 'Supply Chain', designation: 'Warehouse Supervisor', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2023-02-27', manager: 'ACM-010',
    ctc: 360_000, basic: 15_000, hra: 7_500, special: 7_500 },
  { number: 'ACM-042', first: 'Sunita', last: 'Yadav', email: 'sunita@acme.test', role: 'employee',
    department: 'Supply Chain', designation: 'Dispatch Assistant', location: 'Coimbatore', stateCode: 'TN',
    joinedOn: '2025-03-10', manager: 'ACM-041',
    ctc: 240_000, basic: 10_000, hra: 5_000, special: 5_000 },

  // ---- Information Technology -------------------------------------------
  { number: 'ACM-043', first: 'Praveen', last: 'Kumar', email: 'praveen@acme.test', role: 'employee',
    department: 'Information Technology', designation: 'IT Administrator', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2021-01-18', manager: 'ACM-002',
    ctc: 660_000, basic: 22_000, hra: 11_000, special: 22_000 },
  { number: 'ACM-044', first: 'Asha', last: 'Varghese', email: 'asha@acme.test', role: 'employee',
    department: 'Information Technology', designation: 'Support Engineer', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2023-06-12', manager: 'ACM-043',
    ctc: 408_000, basic: 13_600, hra: 6_800, special: 13_600 },
  { number: 'ACM-045', first: 'Sameer', last: 'Kapoor', email: 'sameer@acme.test', role: 'employee',
    department: 'Information Technology', designation: 'Systems Analyst', location: 'Pune', stateCode: 'MH',
    joinedOn: '2024-08-26', manager: 'ACM-043',
    ctc: 612_000, basic: 20_400, hra: 10_200, special: 20_400 },

  // ---- The two role-demo accounts -------------------------------------
  // Finance approves what payroll processes, and the auditor can read everything
  // and change nothing. Both exist so a demo can SHOW separation of duty rather
  // than describe it.
  { number: 'ACM-046', first: 'Deepa', last: 'Menon', email: 'finance@acme.test', role: 'finance',
    department: 'Finance', designation: 'Finance Manager', location: 'Hyderabad', stateCode: 'TS',
    joinedOn: '2020-10-12', manager: 'ACM-002',
    ctc: 1_080_000, basic: 36_000, hra: 18_000, special: 36_000 },
  { number: 'ACM-047', first: 'Ravi', last: 'Kulkarni', email: 'auditor@acme.test', role: 'auditor',
    department: 'Finance', designation: 'Internal Auditor', location: 'Pune', stateCode: 'MH',
    joinedOn: '2021-07-19', manager: 'ACM-002',
    ctc: 900_000, basic: 30_000, hra: 15_000, special: 30_000 },
]

/** The people a demo should log in as, in the order a sales call walks through them. */
export const DEMO_LOGINS = [
  { email: 'admin@acme.test', label: 'Org admin — everything, including settings and billing' },
  { email: 'priya@acme.test', label: 'Head of HR — people, onboarding, documents, approvals' },
  { email: 'anil@acme.test', label: 'Finance Controller — payroll approve and lock' },
  { email: 'arjun@acme.test', label: 'Engineering Manager — team inbox, approvals, reviews' },
  { email: 'rahul@acme.test', label: 'Employee — payslips, leave, attendance, assets' },
  { email: 'finance@acme.test', label: 'Finance — approves the run payroll processed' },
  { email: 'auditor@acme.test', label: 'Auditor — reads everything, changes nothing' },
] as const
